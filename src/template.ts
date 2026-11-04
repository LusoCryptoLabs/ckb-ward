import { ccc } from "@ckb-ccc/core";
import { parseMessage, type MessageFields } from "./message.ts";

/**
 * Domain separation for the proof out point. 18 bytes, ends with a line feed. It names the bytes of
 * the signed transaction, which have not changed since v0, so it stays as it is and old proofs
 * keep their hashes. A change to those bytes gets a new tag.
 */
export const PROOF_TAG = "CKB lock proof v0\n";
/** Output index of the proof out point. No transaction has 2^32 - 1 outputs. */
export const PROOF_INDEX = 0xffffffff;
/**
 * Capacity of the proof input as the verifier resolves it: u64::MAX. A lock that limits what a key
 * may move (a per-transaction cap) then sees the whole account leave, so only a key that may move
 * everything can sign a proof. The signed transaction hash does not cover resolved input cells.
 */
export const PROOF_INPUT_CAPACITY = 0xffffffffffffffffn;
/** Lock of the proof output. Output locks never run; the output only carries the message. */
export const NULL_LOCK = ccc.Script.from({ codeHash: `0x${"00".repeat(32)}`, hashType: "data", args: "0x" });

const SHANNONS = 100000000n;
const utf8 = (text: string) => ccc.bytesFrom(text, "utf8");

/** Proof out point: tx hash = ckbhash(PROOF_TAG || lock script hash || message), index 0xffffffff. */
export function proofOutPoint(lock: ccc.ScriptLike, message: string): ccc.OutPoint {
  const txHash = ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG), ccc.Script.from(lock).hash(), utf8(message)));
  return ccc.OutPoint.from({ txHash, index: PROOF_INDEX });
}

/**
 * The proof transaction: one input at an out point that cannot exist, one output under NULL_LOCK
 * holding the message. Cell deps and witnesses are the wallet's to fill. The input carries the cell
 * the verifier resolves it to (capacity u64::MAX, the lock, no type, no data), so signers can
 * compute the sighash without the chain and see what the lock will see.
 */
export function proofTemplate(lock: ccc.ScriptLike, message: string): ccc.Transaction {
  const script = ccc.Script.from(lock);
  const data = utf8(message);
  const capacity = BigInt(8 + NULL_LOCK.occupiedSize + data.length) * SHANNONS;
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: [],
    inputs: [{ previousOutput: proofOutPoint(script, message), since: 0, cellOutput: { capacity: PROOF_INPUT_CAPACITY, lock: script }, outputData: "0x" }],
    outputs: [{ capacity, lock: NULL_LOCK }],
    outputsData: [ccc.hexFrom(data)],
    witnesses: [],
  });
}

/**
 * For wallets. When `tx` is exactly the proof template for `lock` and the message in its output
 * (one input at index 0xffffffff whose tx hash is derived from the tag, the lock hash and that
 * message), returns the message's fields. A wallet then shows a proof request, not a transfer:
 * the domain, compared with the origin of the site that asks, and the account. Anything else gives
 * undefined.
 */
export function readProof(tx: ccc.TransactionLike, lock: ccc.ScriptLike): MessageFields | undefined {
  const t = ccc.Transaction.from(tx);
  if (t.inputs.length !== 1 || t.outputs.length !== 1 || t.outputsData.length !== 1) return undefined;
  if (t.inputs[0].previousOutput.index !== BigInt(PROOF_INDEX)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(ccc.bytesFrom(t.outputsData[0]));
    const tpl = proofTemplate(lock, text);
    tpl.cellDeps = t.cellDeps.map((d) => d.clone());
    if (tpl.hash() !== t.hash()) return undefined;
    return parseMessage(text);
  } catch {
    return undefined;
  }
}
