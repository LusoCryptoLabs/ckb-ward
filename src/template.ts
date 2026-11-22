import { ccc } from "@ckb-ccc/core";
import { parseMessage, type MessageFields } from "./message.ts";

/**
 * Domain separation for the proof out point. 18 bytes, ends with a line feed. It names the bytes of
 * the signed transaction: a change to those bytes gets a new tag. v1 is the output under the
 * claimed lock; v0 had it under a lock with an all-zero code hash and is no longer accepted.
 */
export const PROOF_TAG = "CKB lock proof v1\n";
/**
 * The tag of form 2 (SPEC section 4, "Form 2"). Form 2 has the same message, output and witness as
 * form 1; only the input differs: it names output 0 of a synthetic previous transaction instead of
 * an out point that cannot exist, so a signer that checks every input against the transaction its
 * hash names can follow it. This tag is in that previous transaction's data.
 */
export const PROOF_TAG_V2 = "CKB lock proof v2\n";
/** The form of the proof: 1 names an out point of index 0xffffffff, 2 a synthetic previous transaction. */
export type ProofVersion = 1 | 2;
/** Output index of the proof out point. No transaction has 2^32 - 1 outputs. */
export const PROOF_INDEX = 0xffffffff;
/**
 * Capacity of the proof input as the verifier resolves it: u64::MAX. A lock that limits what a key
 * may move (a per-transaction cap) then sees the whole account leave, so only a key that may move
 * everything can sign a proof. The signed transaction hash does not cover resolved input cells.
 */
export const PROOF_INPUT_CAPACITY = 0xffffffffffffffffn;
const SHANNONS = 100000000n;
const utf8 = (text: string) => ccc.bytesFrom(text, "utf8");

/**
 * Form 1: tx hash = ckbhash(PROOF_TAG || lock script hash || message), index 0xffffffff.
 * Form 2: the hash of the synthetic previous transaction (proofPrevious), index 0.
 */
export function proofOutPoint(lock: ccc.ScriptLike, message: string, version: ProofVersion = 1): ccc.OutPoint {
  if (version === 2) return ccc.OutPoint.from({ txHash: proofPrevious(lock, message).hash(), index: 0 });
  const txHash = ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG), ccc.Script.from(lock).hash(), utf8(message)));
  return ccc.OutPoint.from({ txHash, index: PROOF_INDEX });
}

/**
 * Form 2's synthetic previous transaction: no inputs (so it can never be committed), the proof input's
 * cell at index 0 (capacity u64::MAX, the claimed lock, no type, no data), and at index 1 an output
 * under the same lock whose data is PROOF_TAG_V2 || lock hash || message, with the capacity that data
 * occupies. Its hash binds the tag, the lock and the message, as form 1's out point does. A host gives it
 * to a signer that asks for the transaction an input names; it is never sent anywhere.
 */
export function proofPrevious(lock: ccc.ScriptLike, message: string): ccc.Transaction {
  const script = ccc.Script.from(lock);
  const data = ccc.bytesConcat(utf8(PROOF_TAG_V2), script.hash(), utf8(message));
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: [],
    inputs: [],
    outputs: [
      { capacity: PROOF_INPUT_CAPACITY, lock: script },
      { capacity: BigInt(8 + script.occupiedSize + data.length) * SHANNONS, lock: script },
    ],
    outputsData: ["0x", ccc.hexFrom(data)],
    witnesses: [],
  });
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
  /** The form of the proof. Default 1. */
  version?: ProofVersion;
}

/**
 * The proof transaction: one input at an out point that cannot exist, one output under the claimed
 * lock holding the message. Output locks never run; the output names the lock, so a wallet reads
 * from the transaction which of its locks is asked to sign. Cell deps and witnesses are the
 * wallet's to fill. The input carries the cell the verifier resolves it to (capacity u64::MAX, the
 * lock, no type, no data), so signers can compute the sighash without the chain and see what the
 * lock will see. `opts` carries a since or header deps for the locks that need them.
 */
export function proofTemplate(lock: ccc.ScriptLike, message: string, opts: ProofOptions = {}): ccc.Transaction {
  const script = ccc.Script.from(lock);
  const data = utf8(message);
  const capacity = BigInt(8 + script.occupiedSize + data.length) * SHANNONS;
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: opts.headerDeps ?? [],
    inputs: [{ previousOutput: proofOutPoint(script, message, opts.version ?? 1), since: opts.since ?? 0, cellOutput: { capacity: PROOF_INPUT_CAPACITY, lock: script }, outputData: "0x" }],
    outputs: [{ capacity, lock: script }],
    outputsData: [ccc.hexFrom(data)],
    witnesses: [],
  });
}

/** The proof template for (lock, message) in `version`, with the cell deps, header deps and since that `tx` carries: what a prover may set. */
export function proofTemplateLike(lock: ccc.ScriptLike, message: string, tx: ccc.Transaction, version: ProofVersion): ccc.Transaction {
  const tpl = proofTemplate(lock, message, { version });
  tpl.cellDeps = tx.cellDeps.map((d) => d.clone());
  tpl.headerDeps = [...tx.headerDeps];
  tpl.inputs[0].since = tx.inputs[0].since;
  return tpl;
}

/** The form (1 or 2) whose template `tx` equals for (lock, message), or undefined when it is neither. */
export function proofVersionOf(lock: ccc.ScriptLike, message: string, tx: ccc.Transaction): ProofVersion | undefined {
  if (tx.inputs.length !== 1 || tx.outputs.length !== 1 || tx.outputsData.length !== 1) return undefined;
  const hash = tx.hash();
  for (const v of [1, 2] as const) if (proofTemplateLike(lock, message, tx, v).hash() === hash) return v;
  return undefined;
}

/**
 * For wallets. When `tx` is exactly the proof template for `lock` and the message in its output
 * (one input at index 0xffffffff whose tx hash is derived from the tag, the lock hash
 * and that message), returns the message's fields. A wallet then shows a proof request, not a
 * transfer: the domain, compared with the origin of the site that asks, and the account. Anything
 * else gives undefined.
 */
export function readProof(tx: ccc.TransactionLike, lock: ccc.ScriptLike): MessageFields | undefined {
  const t = ccc.Transaction.from(tx);
  if (t.inputs.length !== 1 || t.outputs.length !== 1 || t.outputsData.length !== 1) return undefined;
  const index = t.inputs[0].previousOutput.index;
  if (index !== BigInt(PROOF_INDEX) && index !== 0n) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(ccc.bytesFrom(t.outputsData[0]));
    if (proofVersionOf(lock, text, t) === undefined) return undefined;
    const fields = parseMessage(text);
    // The text shows this lock hash line to the person: it must be the lock the transaction is for.
    if (fields.lockHash !== ccc.Script.from(lock).hash()) return undefined;
    return fields;
  } catch {
    return undefined;
  }
}
