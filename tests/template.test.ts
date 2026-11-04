// Offline: the template rebuilt from (lock, message) matches the transactions the wallets signed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { PROOF_INDEX, proofOutPoint, proofTemplate } from "../src/index.ts";
import { otherMessage, vectors } from "./helpers.ts";

function rebuild(v: (typeof vectors)[number], message: string): ccc.Transaction {
  const tpl = proofTemplate(v.lock, message);
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

test("the out point commits to the tag, the lock and the message", () => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const op = proofOutPoint(v.lock, v.message);
  assert.equal(op.index, BigInt(PROOF_INDEX));
  const tag = ccc.bytesFrom("CKB lock proof v0\n", "utf8");
  assert.equal(tag.length, 18);
  assert.equal(op.txHash, ccc.hashCkb(ccc.bytesConcat(tag, ccc.Script.from(v.lock).hash(), ccc.bytesFrom(v.message, "utf8"))));
  const out = proofTemplate(v.lock, v.message).outputs[0];
  assert.equal(out.capacity, BigInt(41 + ccc.bytesFrom(v.message, "utf8").length) * 100000000n);
});
