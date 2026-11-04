import { ccc } from "@ckb-ccc/core";

/** Domain separation for the variant A out point. 18 bytes, ends with a line feed. */
export const PROOF_TAG = "CKB lock proof v0\n";
/** Output index of the variant A out point. No transaction has 2^32 - 1 outputs. */
export const PROOF_INDEX = 0xffffffff;
/** Variant B input since: absolute block number 2^56 - 1, a block the chain will not reach. */
export const NEVER_SINCE = 0x00ffffffffffffffn;
/** Variant B fee in shannons (0.001 CKB), so a node refuses B for its since and not for its fee. */
export const B_FEE = 100000n;
/** Lock of the variant A output. Output locks never run; the output only carries the message. */
export const NULL_LOCK = ccc.Script.from({ codeHash: `0x${"00".repeat(32)}`, hashType: "data", args: "0x" });

const SHANNONS = 100000000n;
const utf8 = (text: string) => ccc.bytesFrom(text, "utf8");

/** Variant A out point: tx hash = ckbhash(PROOF_TAG || lock script hash || message), index 0xffffffff. */
export function proofOutPoint(lock: ccc.ScriptLike, message: string): ccc.OutPoint {
  const txHash = ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG), ccc.Script.from(lock).hash(), utf8(message)));
  return ccc.OutPoint.from({ txHash, index: PROOF_INDEX });
}

/**
 * Variant A: one input at an out point that cannot exist, one output under NULL_LOCK holding the
 * message. Cell deps and witnesses are the wallet's to fill. The input carries its resolved cell
 * (capacity 0, the lock, no type, no data) so signers can compute the sighash without the chain.
 */
export function templateA(lock: ccc.ScriptLike, message: string): ccc.Transaction {
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

/**
 * Variant B: a real live cell of the lock as the only input, with a since that cannot be reached,
 * and one output back to the same lock holding ckbhash(message). Throws when the cell is too small
 * to pay B_FEE and still hold the output.
 */
export function templateB(cell: ccc.CellLike, message: string): ccc.Transaction {
  const c = ccc.Cell.from(cell);
  const lock = c.cellOutput.lock;
  const capacity = c.cellOutput.capacity - B_FEE;
  const needed = BigInt(8 + lock.occupiedSize + 32) * SHANNONS;
  if (capacity < needed) throw new Error(`cell too small for variant B: needs ${needed + B_FEE} shannons`);
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: [],
    inputs: [{ previousOutput: c.outPoint, since: NEVER_SINCE, cellOutput: c.cellOutput, outputData: c.outputData }],
    outputs: [{ capacity, lock }],
    outputsData: [ccc.hashCkb(utf8(message))],
    witnesses: [],
  });
}
