import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { parseMessage, type MessageFields } from "./message.ts";
import type { LockRun, MockCell, MockTransaction, RunLock } from "./runner.ts";
import { PROOF_INPUT_CAPACITY, proofTemplate } from "./template.ts";

/** What the prover hands in: the lock it claims, the message it was asked to sign, the signed tx. */
export interface Proof {
  lock: ccc.ScriptLike;
  message: string;
  tx: ccc.TransactionLike;
}

/**
 * What the platform issued and expects back. Every field but `now` is required: a verifier that
 * skips one accepts proofs made for another platform, account, lock, chain or time.
 */
export interface Expect {
  /** The exact message the platform issued for this nonce, as it stored it. Compared byte for byte. */
  message: string;
  /** The platform's own domain. */
  domain: string;
  /** The account the lock is being linked to. */
  account: string;
  /** The nonce the platform issued for this account and lock. */
  nonce: string;
  /** Genesis hash of the chain, from the platform's config (never from the proof or the node). */
  chain: ccc.HexLike;
  /** How long after "Issued at" the message is still accepted. */
  maxAgeSeconds: number;
  now?: Date;
}

export interface VerifyOptions {
  /** CKB node JSON RPC of the chain in `expect.chain`. Cell deps are read from it. */
  rpcUrl: string;
  runLock: RunLock;
  /** Required. verify() refuses without it. */
  expect: Expect;
  /**
   * Called once, after every check that needs no chain read has passed and before the first chain
   * read. Return false when the nonce is already used; verify() then refuses without reading the
   * chain. Put the platform's compare-and-set here, so each nonce pays for at most one set of chain
   * reads and lock runs, whether the proof is then accepted or not.
   */
  claimNonce?: (fields: MessageFields) => boolean | Promise<boolean>;
  /**
   * After the lock accepts, run it twice more: with an empty witness, and with the same witness on
   * the template of another message. If either opens, nobody holds the lock alone (an
   * always-success lock, or a witness that does not commit to the message, like a password), and
   * the proof is refused. Default true. Turn off only to measure what the probes stop.
   */
  probes?: boolean;
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

/** The proof input as the verifier resolves it: capacity u64::MAX, the claimed lock, no type, no data. */
export function proofInput(lock: ccc.ScriptLike): MockCell {
  return { output: { capacity: ccc.numToHex(PROOF_INPUT_CAPACITY), lock: JsonRpcTransformers.scriptFrom(lock), type: null }, data: "0x", header: null };
}

/** Refuses an `expect` with a field missing or of the wrong type (callers in plain JavaScript). */
function missingExpect(e: Expect | undefined): string | undefined {
  if (e === undefined || e === null || typeof e !== "object") return "expect is required";
  for (const k of ["message", "domain", "account", "nonce"] as const) if (typeof e[k] !== "string" || e[k] === "") return `expect.${k} is required`;
  if (e.chain === undefined || e.chain === null) return "expect.chain is required";
  if (typeof e.maxAgeSeconds !== "number" || !Number.isFinite(e.maxAgeSeconds) || e.maxAgeSeconds < 0) return "expect.maxAgeSeconds is required";
  if (e.now !== undefined && !(e.now instanceof Date)) return "expect.now must be a Date";
  return undefined;
}

function checkExpect(f: MessageFields, e: Expect, chain: ccc.Hex, message: string): string | undefined {
  if (message !== e.message) return "message is not the one issued";
  if (f.domain !== e.domain) return "message is for another domain";
  if (f.account !== e.account) return "message is for another account";
  if (f.nonce !== e.nonce) return "message has another nonce";
  if (f.chain !== chain) return "message names another chain";
  const age = ((e.now ?? new Date()).getTime() - Date.parse(f.issuedAt)) / 1000;
  if (age > e.maxAgeSeconds) return "message expired";
  if (age < -CLOCK_SKEW_SECONDS) return "message issued in the future";
  return undefined;
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The same message with the nonce replaced by a fresh random one: a message nobody was asked to sign. */
function probeMessage(message: string): string {
  const nonce = `probe-${ccc.hexFrom(globalThis.crypto.getRandomValues(new Uint8Array(16))).slice(2)}`;
  return message.replace(/\nNonce: [^\n]*$/, `\nNonce: ${nonce}`);
}

/** The two probes of VerifyOptions.probes. Returns the reason to refuse, or undefined. */
async function noExclusiveControl(lock: ccc.Script, message: string, tx: ccc.Transaction, deps: MockTransaction["mock_info"]["cell_deps"], runLock: RunLock) {
  const empty = tx.clone();
  empty.witnesses = ["0x"];
  const a = await runLock(mockTransaction(empty, proofInput(lock), deps));
  if (a.code === 0) return { reason: "no exclusive control: the lock opens with an empty witness", run: a };
  const other = proofTemplate(lock, probeMessage(message));
  other.cellDeps = tx.cellDeps.map((d) => d.clone());
  other.witnesses = [...tx.witnesses];
  const b = await runLock(mockTransaction(other, proofInput(lock), deps));
  if (b.code === 0) return { reason: "no exclusive control: the same witness opens another message", run: b };
  return undefined;
}

/**
 * Checks a proof. ok: true means the claimed lock accepted the proof transaction that the verifier
 * itself built from (lock, message), with every cell dep read live from the chain, and the message
 * is exactly the one the platform issued (`expect`, required). Refusals that need no chain read
 * come first. Throws only when the node cannot be reached or the runner fails to start.
 */
export async function verify(proof: Proof, options: VerifyOptions): Promise<VerifyResult> {
  const fail = (reason: string, run?: LockRun): VerifyResult => ({ ok: false, reason, run });
  const missing = missingExpect(options?.expect);
  if (missing) return fail(missing);
  const expect = options.expect;
  let lock: ccc.Script, tx: ccc.Transaction, fields: MessageFields, chain: ccc.Hex;
  try {
    chain = ccc.hexFrom(expect.chain);
    lock = ccc.Script.from(proof.lock);
    tx = ccc.Transaction.from(proof.tx);
    fields = parseMessage(proof.message);
  } catch (e) {
    return fail(`malformed proof: ${text(e)}`);
  }
  if (fields.lockHash !== lock.hash()) return fail("message names another lock");
  const expectError = checkExpect(fields, expect, chain, proof.message);
  if (expectError) return fail(expectError);
  if (tx.witnesses.length !== 1) return fail("exactly one witness expected");
  if (tx.cellDeps.length > MAX_CELL_DEPS) return fail("too many cell deps");

  const template = proofTemplate(lock, proof.message);
  template.cellDeps = tx.cellDeps.map((d) => d.clone());
  if (template.hash() !== tx.hash()) return fail("not the proof template for this lock and message");

  // Every check above is free. From here on each step reads the chain or runs the lock.
  if (options.claimNonce && !(await options.claimNonce(fields))) return fail("nonce already used");
  const rpc = jsonRpc(options.rpcUrl);
  if (chain !== (await rpc("get_block_hash", ["0x0"]))) return fail("the node is on another chain");

  let deps: MockTransaction["mock_info"]["cell_deps"];
  try {
    deps = await resolveCellDeps(options.rpcUrl, tx.cellDeps);
  } catch (e) {
    if (e instanceof NotLiveError) return fail(`cell dep ${e.message}`);
    throw e;
  }
  const run = await options.runLock(mockTransaction(tx, proofInput(lock), deps));
  if (run.code === 0) {
    const probe = options.probes === false ? undefined : await noExclusiveControl(lock, proof.message, tx, deps, options.runLock);
    if (probe) return fail(probe.reason, probe.run);
    return { ok: true, fields, cycles: run.cycles };
  }
  if (run.code === null) return fail(`lock did not run: ${run.output.split("\n").at(-1)}`, run);
  return fail(`lock exited ${run.code}`, run);
}
