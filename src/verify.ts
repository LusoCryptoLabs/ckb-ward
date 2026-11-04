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
  /** Timeout of each chain read. Default RPC_TIMEOUT_MS. */
  rpcTimeoutMs?: number;
  /** Largest witness accepted, in bytes. Default MAX_WITNESS_BYTES. */
  maxWitnessBytes?: number;
}

export type VerifyResult = { ok: true; fields: MessageFields; cycles?: bigint } | { ok: false; reason: string; run?: LockRun };

/** Largest number of cell deps a proof may list (JoyID, the largest measured here, uses 5). */
export const MAX_CELL_DEPS = 16;
/**
 * Most cells all dep groups of a proof may list together, counted from the groups' data before any
 * member is read (the secp256k1 dep group, the largest measured here, lists 2).
 */
export const MAX_DEP_GROUP_MEMBERS = 32;
/**
 * Largest transaction, as the node counts it: serialized size in a block (the transaction's bytes
 * plus a 4 byte offset). The consensus block limit on testnet and mainnet; measured on testnet,
 * 597,000 passes that check and 597,001 is refused with ExceededMaximumBlockBytes.
 */
export const MAX_TX_BYTES = 597_000;
/**
 * Default largest witness. The largest measured here is 540 bytes (smart account); this leaves room
 * for post-quantum signatures (SLH-DSA 256f is 49,856 bytes by its parameter set, not measured here).
 */
export const MAX_WITNESS_BYTES = 65_536;
/** Default timeout of one chain read. */
export const RPC_TIMEOUT_MS = 10_000;
/** Allowed clock difference for "Issued at" in the future. */
export const CLOCK_SKEW_SECONDS = 60;

type Rpc = (method: string, params: unknown[]) => Promise<any>;

/** A JSON RPC client. Each call fails after timeoutMs, body included. */
export function jsonRpc(url: string, timeoutMs = RPC_TIMEOUT_MS): Rpc {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: ++id, jsonrpc: "2.0", method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await res.json();
    if (body.error) throw new Error(`${method}: ${body.error.message}`);
    return body.result;
  };
}

/** A cell dep the verifier refuses: not live, not a dep group, listed twice, or too many cells. */
export class CellDepError extends Error {}
/** The chain does not have this cell as live. Network failures are thrown as other errors. */
export class NotLiveError extends CellDepError {}

const key = (op: ccc.OutPoint) => `${op.txHash}:${Number(op.index)}`;

async function liveCell(rpc: Rpc, outPoint: ccc.OutPoint): Promise<MockCell> {
  const r = await rpc("get_live_cell", [JsonRpcTransformers.outPointFrom(outPoint), true]);
  if (r?.status !== "live") throw new NotLiveError(`cell dep ${key(outPoint)} is not live (${r?.status})`);
  return { output: r.cell.output, data: r.cell.data.content, header: null };
}

/** The member count of a dep group cell, read from its data before anything else. */
function depGroupCount(outPoint: ccc.OutPoint, data: Uint8Array): number {
  const n = data.length >= 4 ? Number(ccc.numLeFromBytes(data.slice(0, 4))) : -1;
  if (n < 0 || data.length !== 4 + 36 * n) throw new CellDepError(`cell dep ${key(outPoint)} is not a dep group`);
  return n;
}

/** The first out point listed twice, as the node refuses it (DuplicateCellDeps). */
export function duplicateCellDep(cellDeps: ccc.CellDepLike[]): ccc.OutPoint | undefined {
  const listed = new Set<string>();
  for (const d of cellDeps.map((x) => ccc.CellDep.from(x))) {
    if (listed.has(key(d.outPoint))) return d.outPoint;
    listed.add(key(d.outPoint));
  }
  return undefined;
}

export interface ResolveOptions {
  rpcTimeoutMs?: number;
  /** Default MAX_DEP_GROUP_MEMBERS. */
  maxDepGroupMembers?: number;
}

/**
 * Every cell dep as the chain has it now, read as a live cell, dep groups expanded. Never use cell
 * contents supplied by the prover. Bounded: an out point listed twice is refused before any read;
 * the dep groups' member counts are read from their data and refused above the limit before any
 * member is read; a member already read (listed directly or by another group) is not read again.
 * Throws CellDepError (NotLiveError when a cell is not live).
 */
export async function resolveCellDeps(rpcUrl: string, cellDeps: ccc.CellDepLike[], options: ResolveOptions = {}): Promise<MockTransaction["mock_info"]["cell_deps"]> {
  const max = options.maxDepGroupMembers ?? MAX_DEP_GROUP_MEMBERS;
  const deps = cellDeps.map((d) => ccc.CellDep.from(d));
  const twice = duplicateCellDep(deps);
  if (twice) throw new CellDepError(`cell dep ${key(twice)} is listed twice`);
  const rpc = jsonRpc(rpcUrl, options.rpcTimeoutMs);
  const out: MockTransaction["mock_info"]["cell_deps"] = [];
  const groups: { outPoint: ccc.OutPoint; data: Uint8Array; n: number }[] = [];
  let members = 0;
  for (const dep of deps) {
    const cell = await liveCell(rpc, dep.outPoint);
    out.push({ cell_dep: { out_point: JsonRpcTransformers.outPointFrom(dep.outPoint), dep_type: dep.depType === "depGroup" ? "dep_group" : "code" }, ...cell });
    if (dep.depType !== "depGroup") continue;
    const data = ccc.bytesFrom(cell.data);
    const n = depGroupCount(dep.outPoint, data);
    members += n;
    if (members > max) throw new CellDepError(`cell dep groups list more than ${max} cells`);
    groups.push({ outPoint: dep.outPoint, data, n });
  }
  const seen = new Set(deps.map((d) => key(d.outPoint)));
  for (const g of groups) {
    for (let i = 0; i < g.n; i++) {
      const member = ccc.OutPoint.decode(g.data.slice(4 + 36 * i, 40 + 36 * i));
      if (seen.has(key(member))) continue;
      seen.add(key(member));
      out.push({ cell_dep: { out_point: JsonRpcTransformers.outPointFrom(member), dep_type: "code" }, ...(await liveCell(rpc, member)) });
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
  if (tx.toBytes().length + 4 > MAX_TX_BYTES) return fail("transaction too large");
  if (ccc.bytesLen(tx.witnesses[0]) > (options.maxWitnessBytes ?? MAX_WITNESS_BYTES)) return fail("witness too large");
  if (tx.cellDeps.length > MAX_CELL_DEPS) return fail("too many cell deps");
  const twice = duplicateCellDep(tx.cellDeps);
  if (twice) return fail(`cell dep ${key(twice)} is listed twice`);

  const template = proofTemplate(lock, proof.message);
  template.cellDeps = tx.cellDeps.map((d) => d.clone());
  if (template.hash() !== tx.hash()) return fail("not the proof template for this lock and message");

  // Every check above is free. From here on each step reads the chain or runs the lock.
  if (options.claimNonce && !(await options.claimNonce(fields))) return fail("nonce already used");
  const rpc = jsonRpc(options.rpcUrl, options.rpcTimeoutMs);
  if (chain !== (await rpc("get_block_hash", ["0x0"]))) return fail("the node is on another chain");

  let deps: MockTransaction["mock_info"]["cell_deps"];
  try {
    deps = await resolveCellDeps(options.rpcUrl, tx.cellDeps, { rpcTimeoutMs: options.rpcTimeoutMs });
  } catch (e) {
    if (e instanceof CellDepError) return fail(e.message);
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
