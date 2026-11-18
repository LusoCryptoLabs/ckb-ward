// Offline: the template rebuilt from (lock, message) matches the transactions the wallets signed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG, PROOF_TAG_V1, parseMessage, proofOutPoint, proofTemplate, readProof } from "../src/index.ts";
import { otherMessage, vectors, versionOf } from "./helpers.ts";

function rebuild(v: (typeof vectors)[number], message: string): ccc.Transaction {
  const tpl = proofTemplate(v.lock, message, { version: versionOf(v) });
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

test("the out point commits to the tag of the version, the lock and the message", () => {
  for (const v of vectors) {
    const version = versionOf(v);
    const op = proofOutPoint(v.lock, v.message, version);
    assert.equal(op.index, BigInt(PROOF_INDEX));
    const tag = ccc.bytesFrom(version === 0 ? PROOF_TAG : PROOF_TAG_V1, "utf8");
    assert.equal(tag.length, 18);
    assert.equal(op.txHash, ccc.hashCkb(ccc.bytesConcat(tag, ccc.Script.from(v.lock).hash(), ccc.bytesFrom(v.message, "utf8"))), v.file);
    assert.ok(op.eq(ccc.Transaction.from(v.tx).inputs[0].previousOutput), v.file);
    // The output holds its occupied capacity: 8 of capacity, the lock, then the message. Version 0
    // puts it under the null lock (33 bytes), version 1 under the claimed lock.
    const out = ccc.Transaction.from(v.tx).outputs[0];
    const lockBytes = version === 0 ? 33 : ccc.Script.from(v.lock).occupiedSize;
    assert.equal(out.capacity, BigInt(8 + lockBytes + ccc.bytesFrom(v.message, "utf8").length) * 100000000n, v.file);
    assert.equal(out.lock.eq(ccc.Script.from(v.lock)), version === 1, v.file);
  }
});

test("the input carries the cell the verifier resolves: capacity u64::MAX, the lock, no type, no data", () => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const input = proofTemplate(v.lock, v.message).inputs[0];
  assert.equal(PROOF_INPUT_CAPACITY, 2n ** 64n - 1n);
  assert.equal(input.cellOutput?.capacity, PROOF_INPUT_CAPACITY);
  assert.ok(input.cellOutput?.lock.eq(ccc.Script.from(v.lock)));
  assert.equal(input.cellOutput?.type, undefined);
  assert.equal(input.outputData, "0x");
  // The signed hash does not cover the resolved input, so the signed vectors keep their hashes.
  assert.equal(ccc.numToHex(PROOF_INPUT_CAPACITY), "0xffffffffffffffff");
});

test("readProof: a wallet tells a proof request from a transfer", () => {
  for (const v of vectors) {
    const f = readProof(v.tx, v.lock);
    assert.equal(f?.domain, parseMessage(v.message).domain, v.file);
    assert.equal(f?.account, parseMessage(v.message).account, v.file);
  }
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const other = vectors.find((x) => x.file === "joyid.json")!;
  // Another lock than the wallet's: the out point was derived from another lock hash.
  assert.equal(readProof(v.tx, other.lock), undefined);
  // An ordinary transfer of a real cell, same output and data.
  const transfer = ccc.Transaction.from(v.tx);
  transfer.inputs[0].previousOutput = ccc.OutPoint.from({ txHash: `0x${"11".repeat(32)}`, index: 0 });
  assert.equal(readProof(transfer, v.lock), undefined);
  // Index 0xffffffff but a tx hash not derived from the tag: not a proof either.
  const fake = ccc.Transaction.from(v.tx);
  fake.inputs[0].previousOutput = ccc.OutPoint.from({ txHash: `0x${"11".repeat(32)}`, index: PROOF_INDEX });
  assert.equal(readProof(fake, v.lock), undefined);
  // The message changed in the output: the out point no longer matches it.
  const edited = ccc.Transaction.from(v.tx);
  edited.outputsData[0] = ccc.hexFrom(ccc.bytesFrom(otherMessage(v.message), "utf8"));
  assert.equal(readProof(edited, v.lock), undefined);
});
