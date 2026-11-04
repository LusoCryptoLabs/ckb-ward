// Offline: the templates rebuilt from (lock, message) match the transactions the wallets signed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { B_FEE, NEVER_SINCE, PROOF_INDEX, proofOutPoint, templateA, templateB } from "../src/index.ts";
import { otherMessage, vectors } from "./helpers.ts";

function rebuild(v: (typeof vectors)[number], message: string): ccc.Transaction {
  const tpl = v.variant === "A" ? templateA(v.lock, message) : templateB(v.inputCell!, message);
  tpl.cellDeps = ccc.Transaction.from(v.tx).cellDeps;
  return tpl;
}

for (const v of vectors) {
  test(`${v.name}: template matches the signed transaction`, () => {
    const tx = ccc.Transaction.from(v.tx);
    assert.equal(rebuild(v, v.message).hash(), tx.hash());
  });

  test(`${v.name}: another message gives another transaction`, () => {
    assert.notEqual(rebuild(v, otherMessage(v.message)).hash(), ccc.Transaction.from(v.tx).hash());
  });
}

test("variant A out point commits to the tag, the lock and the message", () => {
  const v = vectors.find((x) => x.file === "secp256k1-a.json")!;
  const op = proofOutPoint(v.lock, v.message);
  assert.equal(op.index, BigInt(PROOF_INDEX));
  const tag = ccc.bytesFrom("CKB lock proof v0\n", "utf8");
  assert.equal(tag.length, 18);
  assert.equal(op.txHash, ccc.hashCkb(ccc.bytesConcat(tag, ccc.Script.from(v.lock).hash(), ccc.bytesFrom(v.message, "utf8"))));
  const out = templateA(v.lock, v.message).outputs[0];
  assert.equal(out.capacity, BigInt(41 + ccc.bytesFrom(v.message, "utf8").length) * 100000000n);
});

test("variant B shape: since 2^56 - 1, fee 0.001 CKB, data = ckbhash(message)", () => {
  const v = vectors.find((x) => x.variant === "B")!;
  const tx = templateB(v.inputCell!, v.message);
  assert.equal(tx.inputs[0].since, NEVER_SINCE);
  assert.equal(ccc.numToHex(NEVER_SINCE), "0xffffffffffffff");
  assert.equal(tx.outputs[0].capacity, ccc.Cell.from(v.inputCell!).cellOutput.capacity - B_FEE);
  assert.equal(tx.outputsData[0], ccc.hashCkb(ccc.bytesFrom(v.message, "utf8")));
});

test("variant B refuses a cell too small to pay the fee and hold the output", () => {
  const v = vectors.find((x) => x.variant === "B")!;
  const lock = ccc.Script.from(v.lock);
  const min = BigInt(8 + lock.occupiedSize + 32) * 100000000n + B_FEE;
  const cell = (capacity: bigint) => ({ outPoint: { txHash: `0x${"11".repeat(32)}`, index: 0 }, cellOutput: { capacity, lock }, outputData: "0x" });
  assert.throws(() => templateB(cell(min - 1n), v.message), /too small/);
  assert.doesNotThrow(() => templateB(cell(min), v.message));
});
