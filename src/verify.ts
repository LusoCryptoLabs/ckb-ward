import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers, type JsonRpcCellOutput } from "@ckb-ccc/core/advanced";
import { parseMessage, type MessageFields } from "./message.ts";
import type { LockRun, MockCell, MockTransaction, RunLock } from "./runner.ts";
import { templateA, templateB } from "./template.ts";

export type Variant = "A" | "B";

/** What the prover hands in: the lock it claims, the message it was asked to sign, the signed tx. */
export interface Proof {
  lock: ccc.ScriptLike;
  message: string;
  tx: ccc.TransactionLike;
  variant: Variant;
}

/** Message checks that depend on the platform. maxAgeSeconds is measured from "Issued at". */
export interface Expect {
  domain?: string;
  account?: string;
  nonce?: string;
  maxAgeSeconds?: number;
  now?: Date;
}

export interface VerifyOptions {
  /** CKB node JSON RPC of the chain named in the message. Cell deps are read from it. */
  rpcUrl: string;
  runLock: RunLock;
  expect?: Expect;
}

export type VerifyResult = { ok: true; fields: MessageFields; cycles?: bigint } | { ok: false; reason: string; run?: LockRun };

/** Largest number of cell deps a proof may list (JoyID, the largest measured here, uses 5). */
export const MAX_CELL_DEPS = 16;
/** Allowed clock difference for "Issued at" in the future. */
export const CLOCK_SKEW_SECONDS = 60;

type Rpc = (method: string, params: unknown[]) => Promise<any>;

export function jsonRpc(url: string): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

/** The chain does not have this cell as live. Network failures are thrown as other errors. */
export class NotLiveError extends Error {}

async function liveCell(rpc: Rpc, outPoint: ccc.OutPoint): Promise<MockCell> {
  const r = await rpc("get_live_cell", [JsonRpcTransformers.outPointFrom(outPoint), true]);
  if (r?.status !== "live") throw new NotLiveError(`${outPoint.txHash}:${Number(outPoint.index)} is not live (${r?.status})`);
  return { output: r.cell.output, data: r.cell.data.content, header: null };
}

function depGroupMembers(outPoint: ccc.OutPoint, data: string): ccc.OutPoint[] {
  const b = ccc.bytesFrom(data);
  const n = b.length >= 4 ? Number(ccc.numLeFromBytes(b.slice(0, 4))) : -1;
  if (n < 0 || b.length !== 4 + 36 * n) throw new NotLiveError(`${outPoint.txHash}:${Number(outPoint.index)} is not a dep group`);
  return Array.from({ length: n }, (_, i) => ccc.OutPoint.decode(b.slice(4 + 36 * i, 40 + 36 * i)));
}

/**
 * Every cell dep as the chain has it now, read as a live cell, dep groups expanded. Throws
 * NotLiveError when one is not live. Never use cell contents supplied by the prover.
 */
export async function resolveCellDeps(rpcUrl: string, cellDeps: ccc.CellDepLike[]): Promise<MockTransaction["mock_info"]["cell_deps"]> {
  const rpc = jsonRpc(rpcUrl);
  const out: MockTransaction["mock_info"]["cell_deps"] = [];
  const seen = new Set<string>();
  const add = (outPoint: ccc.OutPoint, depType: string, cell: MockCell) => {
    const key = `${outPoint.txHash}:${outPoint.index}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ cell_dep: { out_point: JsonRpcTransformers.outPointFrom(outPoint), dep_type: depType }, ...cell });
  };
  for (const dep of cellDeps.map((d) => ccc.CellDep.from(d))) {
    const cell = await liveCell(rpc, dep.outPoint);
    add(dep.outPoint, dep.depType === "depGroup" ? "dep_group" : "code", cell);
    if (dep.depType === "depGroup") {
      for (const member of depGroupMembers(dep.outPoint, cell.data)) add(member, "code", await liveCell(rpc, member));
    }
  }
  return out;
}

/** The ckb-debugger mock for a one input proof transaction. */
export function mockTransaction(tx: ccc.Transaction, input: MockCell, cellDeps: MockTransaction["mock_info"]["cell_deps"]): MockTransaction {
  const i = tx.inputs[0];
  return {
    mock_info: {
      inputs: [{ input: { since: ccc.numToHex(i.since), previous_output: JsonRpcTransformers.outPointFrom(i.previousOutput) }, ...input }],
      cell_deps: cellDeps,
      header_deps: [],
      extensions: [],
    },
    tx: JsonRpcTransformers.transactionFrom(tx),
  };
}

function checkExpect(f: MessageFields, e: Expect | undefined): string | undefined {
  if (!e) return undefined;
  if (e.domain !== undefined && f.domain !== e.domain) return "message is for another domain";
  if (e.account !== undefined && f.account !== e.account) return "message is for another account";
  if (e.nonce !== undefined && f.nonce !== e.nonce) return "message has another nonce";
  if (e.maxAgeSeconds !== undefined) {
    const age = ((e.now ?? new Date()).getTime() - Date.parse(f.issuedAt)) / 1000;
    if (age > e.maxAgeSeconds) return "message expired";
    if (age < -CLOCK_SKEW_SECONDS) return "message issued in the future";
  }
  return undefined;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Checks a proof. ok: true means the claimed lock accepted the proof transaction that the verifier
 * itself built from (lock, message), with every cell dep read live from the chain.
 * Throws only when the node cannot be reached or the runner fails to start.
 */
export async function verify(proof: Proof, options: VerifyOptions): Promise<VerifyResult> {
  const fail = (reason: string, run?: LockRun): VerifyResult => ({ ok: false, reason, run });
  let lock: ccc.Script, tx: ccc.Transaction, fields: MessageFields;
  try {
    lock = ccc.Script.from(proof.lock);
    tx = ccc.Transaction.from(proof.tx);
    fields = parseMessage(proof.message);
  } catch (e) {
    return fail(`malformed proof: ${text(e)}`);
  }
  if (proof.variant !== "A" && proof.variant !== "B") return fail("unknown variant");
  if (fields.lockHash !== lock.hash()) return fail("message names another lock");
  const expectError = checkExpect(fields, options.expect);
  if (expectError) return fail(expectError);
  if (tx.witnesses.length !== 1) return fail("exactly one witness expected");
  if (tx.cellDeps.length > MAX_CELL_DEPS) return fail("too many cell deps");

  const rpc = jsonRpc(options.rpcUrl);
  if (fields.chain !== (await rpc("get_block_hash", ["0x0"]))) return fail("message names another chain");

  let template: ccc.Transaction;
  let input: MockCell;
  if (proof.variant === "A") {
    template = templateA(lock, proof.message);
    input = { output: { capacity: "0x0", lock: JsonRpcTransformers.scriptFrom(lock), type: null }, data: "0x", header: null };
  } else if (proof.variant === "B") {
    if (tx.inputs.length !== 1) return fail("not the proof template for this lock and message");
    const outPoint = tx.inputs[0].previousOutput;
    try {
      input = await liveCell(rpc, outPoint);
    } catch (e) {
      if (e instanceof NotLiveError) return fail(`input ${e.message}`);
      throw e;
    }
    const cell = ccc.Cell.from({ outPoint, cellOutput: JsonRpcTransformers.cellOutputTo(input.output as JsonRpcCellOutput), outputData: input.data });
    if (!cell.cellOutput.lock.eq(lock)) return fail("input is not under the claimed lock");
    try {
      template = templateB(cell, proof.message);
    } catch (e) {
      return fail(text(e));
    }
  } else {
    throw new Error("unreachable");
  }

  template.cellDeps = tx.cellDeps.map((d) => d.clone());
  if (template.hash() !== tx.hash()) return fail("not the proof template for this lock and message");

  let deps: MockTransaction["mock_info"]["cell_deps"];
  try {
    deps = await resolveCellDeps(options.rpcUrl, tx.cellDeps);
  } catch (e) {
    if (e instanceof NotLiveError) return fail(`cell dep ${e.message}`);
    throw e;
  }
  const run = await options.runLock(mockTransaction(tx, input, deps));
  if (run.code === 0) return { ok: true, fields, cycles: run.cycles };
  if (run.code === null) return fail(`lock did not run: ${run.output.split("\n").at(-1)}`, run);
  return fail(`lock exited ${run.code}`, run);
}
