// A lock runner backed by ckb-vm-js (https://github.com/Hanssen0-Alter-Ego/ckb-vm-js): CKB's own
// transaction verifier and CKB-VM compiled to WebAssembly, so a proof can be checked in a browser.
// No Node built-ins here. Ward does not depend on ckb-vm-js: the caller creates the verifier.
import { ccc } from "@ckb-ccc/core";
import { DEFAULT_MAX_CYCLES, type LockRun, type MockTransaction, type RunLock } from "./lock.ts";
import { RPC_TIMEOUT_MS, jsonRpc } from "./verify.ts";

/** What this runner uses of a ckb-vm-js verifier (`createVerifier()` or `createWorkerVerifier()`). */
export interface CkbVmJsVerifier {
  verifyScriptGroup(
    request: unknown,
    // As ckb-vm-js types it, so `await createVerifier()` fits; this runner only asks for "lock".
    group: { group_type: "lock" | "type"; script_hash: `0x${string}` },
  ): Promise<{ ok: boolean; cycles?: string; error?: { code: string; message: string } }>;
}

export interface CkbVmJsOptions {
  verifier: CkbVmJsVerifier;
  /** The chain's RPC. Its consensus is read once, its tip header on every run. */
  rpcUrl: string;
  /** Cycle limit for one run. Default DEFAULT_MAX_CYCLES. */
  maxCycles?: number;
  rpcTimeoutMs?: number;
}

const hex = (n: number | bigint) => `0x${BigInt(n).toString(16)}`;

/** An RPC header or transaction without its `hash`: ckb-vm-js recomputes it and refuses the field. */
function withoutHash(o: unknown): unknown {
  const { hash: _, ...rest } = o as Record<string, unknown>;
  return rest;
}

/**
 * ckb-vm-js's consensus parameters from a node's `get_consensus`. RFC 0044 (the light client) is
 * listed under `softforks`, not `hardfork_features`. The node does not report the block from which a
 * Nervos DAO withdrawing lock is size limited; mainnet and testnet use the default, 10,000,000. Neither
 * of the two changes how a lock runs.
 */
export function ckbVmJsConsensus(c: any): Record<string, unknown> {
  const fork = (rfc: string) => {
    const f = (c.hardfork_features as { rfc: string; epoch_number: string }[]).find((x) => x.rfc === rfc);
    if (!f) throw new Error(`get_consensus: no hardfork feature ${rfc}`);
    return f.epoch_number;
  };
  const lightClient = c.softforks?.light_client?.epoch;
  if (!lightClient) throw new Error("get_consensus: no light client softfork epoch");
  return {
    tx_version: c.tx_version,
    max_block_bytes: c.max_block_bytes,
    max_block_cycles: c.max_block_cycles,
    cellbase_maturity: c.cellbase_maturity,
    median_time_block_count: c.median_time_block_count,
    tx_proposal_window: c.tx_proposal_window,
    dao_type_hash: c.dao_type_hash,
    hardforks: { rfc0028_epoch: fork("0028"), rfc0032_epoch: fork("0032"), rfc0049_epoch: fork("0049"), rfc0044_epoch: lightClient },
    starting_block_limiting_dao_withdrawing_lock: hex(10_000_000),
  };
}

/**
 * The ckb-vm-js request for input 0's lock. Every cell is passed with an unknown origin
 * (`transaction_info: null`): only the lock group runs, and the proof's input cannot exist anyway.
 * Header deps go in as headers, each with no block extension, as the other runners see them.
 */
export function ckbVmJsRequest(mock: MockTransaction, consensus: unknown, tip: unknown, maxCycles: number) {
  const cell = (outPoint: unknown, c: { output: { capacity: string; lock: unknown; type: unknown }; data: string }) => ({
    out_point: outPoint,
    output: { capacity: c.output.capacity, lock: c.output.lock, type: c.output.type ?? null },
    data: c.data,
    transaction_info: null,
  });
  const headers = mock.mock_info.header_deps as { hash: string }[];
  return {
    transaction: withoutHash(mock.tx),
    max_cycles: hex(maxCycles),
    context: {
      consensus,
      tip_header: withoutHash(tip),
      cells: [
        ...mock.mock_info.inputs.map((i) => cell(i.input.previous_output, i)),
        ...mock.mock_info.cell_deps.map((d) => cell(d.cell_dep.out_point, d)),
      ],
      headers: headers.map(withoutHash),
      extensions: headers.map((h) => ({ block_hash: h.hash, data: null })),
    },
  };
}

const EXIT = /^ValidationFailure: see error code (-?\d+) /;

/** A ckb-vm-js result as a LockRun: an exit code only when the lock itself exited. */
export function parseCkbVmJsRun(r: { ok: boolean; cycles?: string; error?: { code: string; message: string } }): LockRun {
  if (r.ok && r.cycles) return { code: 0, cycles: BigInt(r.cycles), output: "" };
  const output = r.error ? `${r.error.code}: ${r.error.message}` : "no result";
  const exit = r.error?.code === "Script" ? EXIT.exec(r.error.message) : null;
  return { code: exit ? Number(exit[1]) : null, output };
}

/**
 * A RunLock backed by ckb-vm-js, for a verifier with no backend. Same exit codes and cycles as
 * ward-vm on every saved proof (2026-11-16, ckb-vm-js 0.2.0 at ae73c4a).
 *
 *   import { createVerifier } from "ckb-vm-js";
 *   const runLock = ckbVmJs({ verifier: await createVerifier(), rpcUrl });
 */
export function ckbVmJs(options: CkbVmJsOptions): RunLock {
  const rpc = jsonRpc(options.rpcUrl, options.rpcTimeoutMs ?? RPC_TIMEOUT_MS);
  let consensus: Promise<unknown> | undefined;
  return async (mock) => {
    consensus ??= rpc("get_consensus", []).then(ckbVmJsConsensus);
    consensus.catch(() => (consensus = undefined));
    const [c, tip] = await Promise.all([consensus, rpc("get_tip_header", [])]);
    const l = mock.mock_info.inputs[0]!.output.lock as { code_hash: string; hash_type: string; args: string };
    const script_hash = ccc.Script.from({ codeHash: l.code_hash, hashType: l.hash_type as ccc.HashTypeLike, args: l.args }).hash();
    const r = await options.verifier.verifyScriptGroup(ckbVmJsRequest(mock, c, tip, options.maxCycles ?? DEFAULT_MAX_CYCLES), { group_type: "lock", script_hash });
    return parseCkbVmJsRun(r);
  };
}
