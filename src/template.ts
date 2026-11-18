import { ccc } from "@ckb-ccc/core";
import { parseMessage, type MessageFields } from "./message.ts";

/**
 * Domain separation for the proof out point. 18 bytes, ends with a line feed. It names the bytes of
 * the signed transaction, which have not changed since v0, so it stays as it is and old proofs
 * keep their hashes. A change to those bytes gets a new tag.
 */
export const PROOF_TAG = "CKB lock proof v0\n";
/**
 * Tag of version 1 of the signed bytes: the proof output is under the claimed lock, not under
 * NULL_LOCK, so a wallet reads from the transaction alone which of its locks is asked to sign.
 */
export const PROOF_TAG_V1 = "CKB lock proof v1\n";
/** Version of the signed bytes. 0: output under NULL_LOCK. 1: output under the claimed lock. */
export type ProofVersion = 0 | 1;
/** What `proofTemplate` builds when no version is given. Verifiers accept every version. */
export const PROOF_VERSION: ProofVersion = 1;
const TAGS: Record<ProofVersion, string> = { 0: PROOF_TAG, 1: PROOF_TAG_V1 };
/** Output index of the proof out point. No transaction has 2^32 - 1 outputs. */
export const PROOF_INDEX = 0xffffffff;
/**
 * Capacity of the proof input as the verifier resolves it: u64::MAX. A lock that limits what a key
 * may move (a per-transaction cap) then sees the whole account leave, so only a key that may move
 * everything can sign a proof. The signed transaction hash does not cover resolved input cells.
 */
export const PROOF_INPUT_CAPACITY = 0xffffffffffffffffn;
/** Lock of the proof output in version 0. Output locks never run; the output only carries the message. */
export const NULL_LOCK = ccc.Script.from({ codeHash: `0x${"00".repeat(32)}`, hashType: "data", args: "0x" });

const SHANNONS = 100000000n;
const utf8 = (text: string) => ccc.bytesFrom(text, "utf8");

/** Proof out point: tx hash = ckbhash(tag of the version || lock script hash || message), index 0xffffffff. */
export function proofOutPoint(lock: ccc.ScriptLike, message: string, version: ProofVersion = PROOF_VERSION): ccc.OutPoint {
  const txHash = ccc.hashCkb(ccc.bytesConcat(utf8(TAGS[version]), ccc.Script.from(lock).hash(), utf8(message)));
  return ccc.OutPoint.from({ txHash, index: PROOF_INDEX });
}

/**
 * Options for a lock that needs more than a plain signature over the transaction hash. Both default
 * to the plain proof (since 0, no header deps) and are not pinned by the verifier: like cell deps,
 * the verifier copies them from the submitted transaction before the template check and resolves the
 * header deps live. A lock that reads them (a matured absolute time lock, a header-reading lock) can
 * then be proven; they cannot forge control, since the signature over the transaction hash is still
 * required and the "no exclusive control" probes still run.
 */
export interface ProofOptions {
  /** The input's `since`. Set it to satisfy a matured absolute time lock (section 12). */
  since?: ccc.NumLike;
  /** Block hashes a header-reading lock needs. The verifier reads the headers live (section 12). */
  headerDeps?: ccc.HexLike[];
  /** Version of the signed bytes. Default PROOF_VERSION. */
  version?: ProofVersion;
}

/**
 * The proof transaction: one input at an out point that cannot exist, one output holding the message,
 * under the claimed lock (version 1) or under NULL_LOCK (version 0). Output locks never run. Cell deps and witnesses are the wallet's to fill. The input carries the cell
 * the verifier resolves it to (capacity u64::MAX, the lock, no type, no data), so signers can
 * compute the sighash without the chain and see what the lock will see. `opts` carries a since or
 * header deps for the locks that need them.
 */
export function proofTemplate(lock: ccc.ScriptLike, message: string, opts: ProofOptions = {}): ccc.Transaction {
  const script = ccc.Script.from(lock);
  const data = utf8(message);
  const version = opts.version ?? PROOF_VERSION;
  const outputLock = version === 0 ? NULL_LOCK : script;
  const capacity = BigInt(8 + outputLock.occupiedSize + data.length) * SHANNONS;
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: opts.headerDeps ?? [],
    inputs: [{ previousOutput: proofOutPoint(script, message, version), since: opts.since ?? 0, cellOutput: { capacity: PROOF_INPUT_CAPACITY, lock: script }, outputData: "0x" }],
    outputs: [{ capacity, lock: outputLock }],
    outputsData: [ccc.hexFrom(data)],
    witnesses: [],
  });
}

/**
 * The version whose template for (lock, message) is exactly `tx`, cell deps, header deps and since
 * aside (they are the prover's to fill). Undefined when no version matches.
 */
export function proofVersion(tx: ccc.TransactionLike, lock: ccc.ScriptLike, message: string): ProofVersion | undefined {
  const t = ccc.Transaction.from(tx);
  if (t.inputs.length !== 1) return undefined;
  for (const version of [1, 0] as const) {
    const tpl = proofTemplate(lock, message, { version });
    tpl.cellDeps = t.cellDeps.map((d) => d.clone());
    tpl.headerDeps = [...t.headerDeps];
    tpl.inputs[0].since = t.inputs[0].since;
    if (tpl.hash() === t.hash()) return version;
  }
  return undefined;
}

/**
 * For wallets. When `tx` is exactly the proof template for `lock` and the message in its output, in
 * any version (one input at index 0xffffffff whose tx hash is derived from the tag, the lock hash
 * and that message), returns the message's fields. A wallet then shows a proof request, not a
 * transfer: the domain, compared with the origin of the site that asks, and the account. Anything
 * else gives undefined.
 */
export function readProof(tx: ccc.TransactionLike, lock: ccc.ScriptLike): MessageFields | undefined {
  const t = ccc.Transaction.from(tx);
  if (t.inputs.length !== 1 || t.outputs.length !== 1 || t.outputsData.length !== 1) return undefined;
  if (t.inputs[0].previousOutput.index !== BigInt(PROOF_INDEX)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(ccc.bytesFrom(t.outputsData[0]));
    if (proofVersion(t, lock, text) === undefined) return undefined;
    return parseMessage(text);
  } catch {
    return undefined;
  }
}
