import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { RPC_TIMEOUT_MS, jsonRpc } from "./verify.ts";

/** Where one cell stood at the snapshot block. */
export interface DepAtSnapshot {
  outPoint: ccc.OutPoint;
  live: boolean;
  /** Block that committed the cell. */
  createdAt?: bigint;
  /** Block whose transaction spent it, when that block is at or before the snapshot. */
  spentAt?: bigint;
  reason: string;
}

export interface DepsAtSnapshot {
  /** True when every cell was live at the snapshot block: the binding counts. */
  live: boolean;
  deps: DepAtSnapshot[];
}

export interface SnapshotOptions {
  /** Timeout of each chain read. Default RPC_TIMEOUT_MS. */
  rpcTimeoutMs?: number;
  /** Most pages of 100 indexer entries read per spent cell before giving up. Default 20. */
  maxPages?: number;
}

const hex = (n: bigint) => ccc.numToHex(n);

/**
 * Platform rule 8 (spec section 9): a binding counts at a snapshot block only when every cell its
 * proof ran with (`cellDeps` from `verify()`) was live at that block, that is committed in a block
 * at or before it and not spent in a block at or before it. A key rotation, a recovery or a lock
 * upgrade spends one of those cells; the owner then proves again.
 *
 * Reads the node's transactions and its indexer. A spent cell's spender is looked up by the cell's
 * type script when it has one, else by its lock, inside the blocks from its creation to the
 * snapshot. Throws when the snapshot is past the tip, or when that search does not end within
 * `maxPages`: an answer it cannot give is not given as live.
 */
export async function depsLiveAt(rpcUrl: string, cellDeps: ccc.OutPointLike[], snapshot: ccc.NumLike, options: SnapshotOptions = {}): Promise<DepsAtSnapshot> {
  const rpc = jsonRpc(rpcUrl, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
  const at = ccc.numFrom(snapshot);
  const tip = BigInt((await rpc("get_tip_header", [])).number);
  if (at > tip) throw new Error(`snapshot block ${at} is past the tip ${tip}`);
  const maxPages = options.maxPages ?? 20;

  const deps: DepAtSnapshot[] = [];
  for (const like of cellDeps) {
    const outPoint = ccc.OutPoint.from(like);
    const index = Number(outPoint.index);
    const tx = await rpc("get_transaction", [outPoint.txHash]);
    if (tx?.tx_status?.status !== "committed") {
      deps.push({ outPoint, live: false, reason: `its transaction is ${tx?.tx_status?.status ?? "unknown"}` });
      continue;
    }
    const createdAt = BigInt(tx.tx_status.block_number);
    const output = tx.transaction.outputs[index];
    if (!output) {
      deps.push({ outPoint, live: false, createdAt, reason: "its transaction has no such output" });
      continue;
    }
    if (createdAt > at) {
      deps.push({ outPoint, live: false, createdAt, reason: `created in block ${createdAt}, after the snapshot` });
      continue;
    }
    const now = await rpc("get_live_cell", [JsonRpcTransformers.outPointFrom(outPoint), false]);
    if (now?.status === "live") {
      deps.push({ outPoint, live: true, createdAt, reason: "live now, so live at the snapshot" });
      continue;
    }
    const spentAt = await spentBy(rpc, outPoint, output, createdAt, at, maxPages);
    deps.push(
      spentAt === undefined
        ? { outPoint, live: true, createdAt, reason: "spent after the snapshot" }
        : { outPoint, live: false, createdAt, spentAt, reason: `spent in block ${spentAt}, at or before the snapshot` },
    );
  }
  return { live: deps.every((d) => d.live), deps };
}

/** The block, at or before `to`, of the transaction that spent `outPoint`; undefined when none did. */
async function spentBy(
  rpc: ReturnType<typeof jsonRpc>,
  outPoint: ccc.OutPoint,
  output: { lock: unknown; type: unknown },
  from: bigint,
  to: bigint,
  maxPages: number,
): Promise<bigint | undefined> {
  const [script, scriptType] = output.type ? [output.type, "type"] : [output.lock, "lock"];
  const searchKey = { script, script_type: scriptType, script_search_mode: "exact", filter: { block_range: [hex(from), hex(to + 1n)] } };
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const r: { objects: { tx_hash: string; block_number: string; io_index: string; io_type: string }[]; last_cursor: string } = await rpc(
      "get_transactions",
      cursor ? [searchKey, "asc", "0x64", cursor] : [searchKey, "asc", "0x64"],
    );
    for (const o of r.objects) {
      if (o.io_type !== "input") continue;
      const spender = await rpc("get_transaction", [o.tx_hash]);
      const prev = spender?.transaction?.inputs?.[Number(o.io_index)]?.previous_output;
      if (prev && prev.tx_hash === outPoint.txHash && Number(prev.index) === Number(outPoint.index)) return BigInt(o.block_number);
    }
    if (r.objects.length < 100) return undefined;
    cursor = r.last_cursor;
  }
  throw new Error(`could not find what spent ${outPoint.txHash}:${Number(outPoint.index)} within ${maxPages} pages`);
}
