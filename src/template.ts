import { ccc } from "@ckb-ccc/core";

/**
 * Domain separation for the proof out point. 18 bytes, ends with a line feed. It names the bytes of
 * the signed transaction, which have not changed since v0, so it stays as it is and old proofs
 * keep their hashes. A change to those bytes gets a new tag.
 */
export const PROOF_TAG = "CKB lock proof v0\n";
/** Output index of the proof out point. No transaction has 2^32 - 1 outputs. */
export const PROOF_INDEX = 0xffffffff;
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
 * holding the message. Cell deps and witnesses are the wallet's to fill. The input carries its
 * resolved cell (the lock, no type, no data) so signers can compute the sighash without the chain.
 */
export function proofTemplate(lock: ccc.ScriptLike, message: string): ccc.Transaction {
  const script = ccc.Script.from(lock);
  const data = utf8(message);
  const capacity = BigInt(8 + NULL_LOCK.occupiedSize + data.length) * SHANNONS;
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: [],
    inputs: [{ previousOutput: proofOutPoint(script, message), since: 0, cellOutput: { capacity: 0, lock: script }, outputData: "0x" }],
    outputs: [{ capacity, lock: NULL_LOCK }],
    outputsData: [ccc.hexFrom(data)],
    witnesses: [],
  });
}
