// Offline: the template-hash gate pins every raw field of the proof transaction. For each vector,
// perturb one field at a time and confirm verify() refuses with "not the proof template", while the
// untouched proof gets past the gate (it reaches the chain read and throws on the unreachable node).
// This is the control that proves each refusal is the template check, not something refused anyway.
// Witnesses are deliberately NOT pinned by the hash (they carry the signature), so a witness change
// is expected to pass the gate; the lock then rejects a tampered one, which the vector tests cover.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { verify, type RunLock } from "../src/index.ts";
import { expectFor, vectors } from "./helpers.ts";

const never: RunLock = async () => {
  throw new Error("the lock must not run");
};
const UNREACHABLE = "http://127.0.0.1:1/unreachable";
const PINNED = "not the proof template for this lock and message";

// One-field edits of a proof transaction, each of which the template pins: it changes the tx hash
// and is refused as not the template. Cell deps, header deps, the input's since and the witness are
// deliberately NOT here: the verifier copies them from the submitted transaction (see the tests
// below), so a lock that reads them can run.
const mutations: { name: string; edit: (tx: ccc.Transaction) => void }[] = [
  { name: "input out point tx hash", edit: (tx) => (tx.inputs[0].previousOutput.txHash = ccc.hexFrom(ccc.bytesFrom(tx.inputs[0].previousOutput.txHash).map((b, i) => (i === 0 ? b ^ 1 : b)))) },
  { name: "input index (not 0xffffffff)", edit: (tx) => (tx.inputs[0].previousOutput.index = 0n) },
  { name: "a second input", edit: (tx) => tx.inputs.push(tx.inputs[0].clone()) },
  { name: "output capacity", edit: (tx) => (tx.outputs[0].capacity += 1n) },
  { name: "output lock args", edit: (tx) => (tx.outputs[0].lock.args = "0x01") },
  { name: "output lock code hash", edit: (tx) => (tx.outputs[0].lock.codeHash = ccc.hexFrom(new Uint8Array(32).fill(9))) },
  { name: "output type", edit: (tx) => (tx.outputs[0].type = ccc.Script.from({ codeHash: ccc.hexFrom(new Uint8Array(32).fill(9)), hashType: "type", args: "0x" })) },
  { name: "output data", edit: (tx) => (tx.outputsData[0] = "0x01") },
  { name: "a second output", edit: (tx) => (tx.outputs.push(tx.outputs[0].clone()), tx.outputsData.push("0x")) },
  { name: "version", edit: (tx) => (tx.version += 1n) },
];

for (const v of vectors) {
  const proof = { lock: v.lock, message: v.message, tx: v.tx };
  const opts = { rpcUrl: UNREACHABLE, runLock: never, expect: expectFor(v.message) };

  test(`${v.file}: the template pins every raw field`, async () => {
    // Control: the untouched proof passes the gate and only then reaches the (unreachable) node.
    await assert.rejects(verify(proof, opts), /fetch failed|ECONNREFUSED|other chain/, "the untouched proof must get past the template check");

    for (const m of mutations) {
      const tx = ccc.Transaction.from(v.tx).clone();
      m.edit(tx);
      assert.notEqual(tx.hash(), ccc.Transaction.from(v.tx).hash(), `${m.name} should change the tx hash`);
      const r = await verify({ ...proof, tx }, opts);
      assert.equal(r.ok, false, `${m.name} must be refused`);
      assert.equal(r.ok ? "" : r.reason, PINNED, `${m.name} must be refused as not the template`);
    }
  });
}

// Mutations caught before the template check, by their own gate.
test("earlier gates: witness count, cell dep count and duplicates", async () => {
  const v = vectors.find((x) => x.file === "secp256k1.json") ?? vectors[0];
  const proof = { lock: v.lock, message: v.message, tx: v.tx };
  const opts = { rpcUrl: UNREACHABLE, runLock: never, expect: expectFor(v.message) };
  const reason = async (tx: ccc.Transaction) => {
    const r = await verify({ ...proof, tx }, opts);
    return r.ok ? "ACCEPTED" : r.reason;
  };

  const twoWitnesses = ccc.Transaction.from(v.tx).clone();
  twoWitnesses.witnesses.push("0x");
  assert.equal(await reason(twoWitnesses), "exactly one witness expected");

  const base = ccc.Transaction.from(v.tx).clone();
  const dep = base.cellDeps[0] ?? ccc.CellDep.from({ outPoint: { txHash: ccc.hexFrom(new Uint8Array(32).fill(2)), index: 0 }, depType: "code" });
  const dup = ccc.Transaction.from(v.tx).clone();
  dup.cellDeps = [dep.clone(), dep.clone()];
  assert.match(await reason(dup), /is listed twice/);

  const many = ccc.Transaction.from(v.tx).clone();
  many.cellDeps = Array.from({ length: 17 }, (_, i) => ccc.CellDep.from({ outPoint: { txHash: ccc.hexFrom(new Uint8Array(32).fill(i + 1)), index: 0 }, depType: "code" }));
  assert.equal(await reason(many), "too many cell deps");
});

// The witness, the input's since and header deps are deliberately not pinned: the verifier copies
// the since and header deps from the submitted transaction, and the hash never covered the witness.
// Each edit must pass the template gate and reach the chain (here, the unreachable node), so a lock
// that reads them can run; it is not refused as "not the proof template".
test("the witness, since and header deps are not pinned by the template", async () => {
  const v = vectors.find((x) => x.file === "secp256k1.json") ?? vectors[0];
  const opts = { rpcUrl: UNREACHABLE, runLock: never, expect: expectFor(v.message) };
  const PAST_GATE = /fetch failed|ECONNREFUSED|other chain/;

  const flipped = ccc.Transaction.from(v.tx).clone();
  const w = ccc.bytesFrom(flipped.witnesses[0]).slice();
  w[v.signatureByte] ^= 0x01;
  flipped.witnesses[0] = ccc.hexFrom(w);
  await assert.rejects(verify({ lock: v.lock, message: v.message, tx: flipped }, opts), PAST_GATE, "a witness edit passes the gate (the signature is not hashed)");

  const sinceSet = ccc.Transaction.from(v.tx).clone();
  sinceSet.inputs[0].since = 1n;
  await assert.rejects(verify({ lock: v.lock, message: v.message, tx: sinceSet }, opts), PAST_GATE, "a since passes the gate (the verifier copies it)");

  const headerDep = ccc.Transaction.from(v.tx).clone();
  headerDep.headerDeps.push(ccc.hexFrom(new Uint8Array(32).fill(1)));
  await assert.rejects(verify({ lock: v.lock, message: v.message, tx: headerDep }, opts), PAST_GATE, "a header dep passes the gate (the verifier copies it)");
});
