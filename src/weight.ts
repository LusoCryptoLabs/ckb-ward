import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { RPC_TIMEOUT_MS, jsonRpc } from "./verify.ts";

/** The Nervos DAO type script's code hash (hash_type type), the same on mainnet and testnet. */
export const NERVOS_DAO_CODE_HASH = "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e";
/** A deposit's data: 8 zero bytes. A withdrawing cell (phase 1) holds its deposit's block number. */
export const DAO_DEPOSIT_DATA = "0x0000000000000000";

/** One cell with the Nervos DAO type under the lock, live at the snapshot block. */
export interface DaoCell {
  outPoint: ccc.OutPoint;
  /** Shannons. */
  capacity: bigint;
  /** Block that committed the cell. */
  createdAt: bigint;
}

export interface DaoWeight {
  /** Shannons in Nervos DAO deposits under the lock, live at the snapshot block. */
  weight: bigint;
  deposits: DaoCell[];
  /** Live at the snapshot with the DAO type but in phase 1 of a withdrawal: not counted. */
  withdrawing: DaoCell[];
}

export interface WeightOptions {
  /** Timeout of each chain read. Default RPC_TIMEOUT_MS. */
  rpcTimeoutMs?: number;
  /** Most pages of 100 indexer entries read before giving up. Default 50. */
  maxPages?: number;
}

const hex = (n: bigint) => ccc.numToHex(n);
const key = (txHash: string, index: number | string) => `${txHash}:${Number(index)}`;

/**
 * Platform rule 8 (spec section 9): the weight of a lock at a snapshot block, as the Nervos DAO
 * deposits under exactly that lock that were live at that block (committed in a block at or before
 * it, not spent in a block at or before it). A cell counts only with the DAO type and 8 zero bytes
 * of data: a withdrawing cell keeps the type, and counting it let one deposit count twice when it
 * moved between snapshot and tally. The indexer is searched by the exact lock, and each cell's lock
 * and type are checked again in the transaction that made it.
 *
 * Reads the node's indexer and transactions. Throws when the snapshot is past the tip, or when the
 * lock's DAO history does not end within `maxPages`: a weight it cannot read in full is not given.
 */
export async function daoWeightAt(rpcUrl: string, lock: ccc.ScriptLike, snapshot: ccc.NumLike, options: WeightOptions = {}): Promise<DaoWeight> {
  const rpc = jsonRpc(rpcUrl, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
  const at = ccc.numFrom(snapshot);
  const tip = BigInt((await rpc("get_tip_header", [])).number);
  if (at > tip) throw new Error(`snapshot block ${at} is past the tip ${tip}`);
  const maxPages = options.maxPages ?? 50;
  const script = ccc.Script.from(lock);
  const lockHash = script.hash();
  const searchKey = {
    script: JsonRpcTransformers.scriptFrom(script),
    script_type: "lock",
    script_search_mode: "exact",
    filter: { script: { code_hash: NERVOS_DAO_CODE_HASH, hash_type: "type", args: "0x" }, block_range: ["0x0", hex(at + 1n)] },
  };

  const txs = new Map<string, any>();
  const tx = async (h: string) => {
    if (!txs.has(h)) txs.set(h, (await rpc("get_transaction", [h]))?.transaction);
    return txs.get(h);
  };
  const made = new Map<string, DaoCell & { data: string }>();
  const spent = new Set<string>();

  let cursor: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= maxPages) throw new Error(`the DAO history of ${lockHash} did not end within ${maxPages} pages`);
    const r: { objects: { tx_hash: string; block_number: string; io_index: string; io_type: string }[]; last_cursor: string } = await rpc(
      "get_transactions",
      cursor ? [searchKey, "asc", "0x64", cursor] : [searchKey, "asc", "0x64"],
    );
    for (const o of r.objects) {
      const t = await tx(o.tx_hash);
      const i = Number(o.io_index);
      if (o.io_type === "input") {
        const prev = t?.inputs?.[i]?.previous_output;
        if (prev) spent.add(key(prev.tx_hash, prev.index));
        continue;
      }
      const out = t?.outputs?.[i];
      const data: string | undefined = t?.outputs_data?.[i];
      if (!out || data === undefined) continue;
      if (ccc.Script.from(JsonRpcTransformers.scriptTo(out.lock)).hash() !== lockHash) continue;
      const type = out.type;
      if (!type || type.code_hash !== NERVOS_DAO_CODE_HASH || type.hash_type !== "type" || type.args !== "0x") continue;
      made.set(key(o.tx_hash, i), {
        outPoint: ccc.OutPoint.from({ txHash: o.tx_hash, index: i }),
        capacity: BigInt(out.capacity),
        createdAt: BigInt(o.block_number),
        data,
      });
    }
    if (r.objects.length < 100) break;
    cursor = r.last_cursor;
  }

  const deposits: DaoCell[] = [];
  const withdrawing: DaoCell[] = [];
  for (const [k, { data, ...cell }] of made) {
    if (spent.has(k)) continue;
    (data === DAO_DEPOSIT_DATA ? deposits : withdrawing).push(cell);
  }
  return { weight: deposits.reduce((s, c) => s + c.capacity, 0n), deposits, withdrawing };
}
