// Version 1 of the signed bytes: the proof output is under the claimed lock, so a wallet reads from
// the transaction which of its locks is asked to sign. The earlier form (tag v0, output under a
// lock with an all-zero code hash) is no longer a proof. Offline tests for the template; with the
// network and a lock runner, proofs signed here with local keys, one control per claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG, message, mockTransaction, proofInput, proofOutPoint, proofTemplate, readProof, resolveCellDeps, verify } from "../src/index.ts";
import { NO_VM, RPC_URL, expectFor, flipWitnessByte, runLock, vectors } from "./helpers.ts";
import { TESTNET_GENESIS } from "./stub.ts";

const lockA = ccc.Script.from({ codeHash: `0x${"aa".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(20)}` });
const lockB = ccc.Script.from({ codeHash: `0x${"aa".repeat(32)}`, hashType: "type", args: `0x${"02".repeat(20)}` });
const textFor = (lock: ccc.Script, nonce: string) => message({ domain: "dao.example", account: "acct", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce });
const utf8 = (s: string) => ccc.bytesFrom(s, "utf8");

/** The earlier form of the proof transaction, built by hand: tag v0, output under the all-zero lock, (41 + n) CKB. */
function earlierForm(lock: ccc.Script, text: string): ccc.Transaction {
  const txHash = ccc.hashCkb(ccc.bytesConcat(utf8("CKB lock proof v0\n"), lock.hash(), utf8(text)));
  return ccc.Transaction.from({
    version: 0,
    cellDeps: [],
    headerDeps: [],
    inputs: [{ previousOutput: { txHash, index: PROOF_INDEX }, since: 0, cellOutput: { capacity: PROOF_INPUT_CAPACITY, lock }, outputData: "0x" }],
    outputs: [{ capacity: BigInt(41 + utf8(text).length) * 100000000n, lock: { codeHash: `0x${"00".repeat(32)}`, hashType: "data", args: "0x" } }],
    outputsData: [ccc.hexFrom(utf8(text))],
    witnesses: [],
  });
}

test("the tag names version 1 of the signed bytes", () => {
  assert.equal(PROOF_TAG, "CKB lock proof v1\n");
  assert.equal(utf8(PROOF_TAG).length, 18);
});

test("the output is under the claimed lock and holds its occupied capacity", () => {
  const text = textFor(lockA, "shape");
  const n = utf8(text).length;
  const tx = proofTemplate(lockA, text);
  assert.ok(tx.outputs[0].lock.eq(lockA));
  // 8 of capacity, 32 + 1 + 20 of the lock, then the data: the output's occupied capacity.
  assert.equal(tx.outputs[0].capacity, BigInt(8 + 53 + n) * 100000000n);
  assert.equal(tx.outputs[0].type, undefined);
  assert.equal(tx.outputsData[0], ccc.hexFrom(utf8(text)));
  assert.equal(tx.inputs[0].previousOutput.txHash, ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG), lockA.hash(), utf8(text))));
  assert.ok(proofOutPoint(lockA, text).eq(tx.inputs[0].previousOutput));
  // The input cell: capacity u64::MAX, the claimed lock.
  assert.equal(tx.inputs[0].cellOutput?.capacity, 2n ** 64n - 1n);
  assert.ok(tx.inputs[0].cellOutput?.lock.eq(lockA));
});

test("readProof reads the template for its lock, and for no other lock", () => {
  const text = textFor(lockA, "detect");
  const tx = proofTemplate(lockA, text);
  assert.equal(readProof(tx, lockA)?.nonce, "detect");
  assert.equal(readProof(tx, lockB), undefined);
});

test("an output lock that is not the lock the out point commits to matches nobody", () => {
  // A site asks a wallet that holds lock A to sign: out point derived for lock B, output under A.
  const text = textFor(lockB, "swap");
  const tx = proofTemplate(lockB, text);
  tx.outputs[0].lock = lockA;
  assert.equal(readProof(tx, lockA), undefined);
  assert.equal(readProof(tx, lockB), undefined);
  // Control: the untouched template is a proof for B.
  assert.equal(readProof(proofTemplate(lockB, text), lockB)?.nonce, "swap");
});

test("the earlier form is not read as a proof, whole or mixed with the current one", () => {
  const text = textFor(lockA, "earlier");
  const old = earlierForm(lockA, text);
  assert.equal(readProof(old, lockA), undefined);
  // The current out point over the earlier output, and the reverse.
  const mixA = proofTemplate(lockA, text);
  mixA.outputs[0] = old.outputs[0].clone();
  assert.equal(readProof(mixA, lockA), undefined);
  const mixB = earlierForm(lockA, text);
  mixB.outputs[0] = proofTemplate(lockA, text).outputs[0].clone();
  assert.equal(readProof(mixB, lockA), undefined);
  // Control: the current template for the same lock and message is read.
  assert.equal(readProof(proofTemplate(lockA, text), lockA)?.nonce, "earlier");
});

test("every saved vector says version 1 and reads as a proof for its lock", () => {
  for (const v of vectors) {
    assert.equal(v.version, 1, v.file);
    assert.ok(readProof(v.tx, v.lock), v.file);
  }
});

// ---- signed here, verified with the lock runner ----

const KEY = `0x${"11".repeat(32)}`;
// The HTTP endpoint: the default WebSocket one keeps the test process open.
const client = new ccc.ClientPublicTestnet({ url: RPC_URL });
const signers: Record<string, () => Promise<{ signer: ccc.Signer; lock: ccc.Script }>> = {
  secp256k1: async () => {
    const signer = new ccc.SignerCkbPrivateKey(client, KEY);
    return { signer, lock: (await signer.getAddressObjSecp256k1()).script };
  },
  "anyone-can-pay": async () => {
    const signer = new ccc.SignerCkbPrivateKey(client, KEY);
    const { args } = (await signer.getAddressObjSecp256k1()).script;
    return { signer, lock: await ccc.Script.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, args) };
  },
  nostr: async () => {
    const signer = new ccc.SignerNostrPrivateKey(client, KEY);
    return { signer, lock: (await signer.getRecommendedAddressObj()).script };
  },
};

async function signed(name: string, nonce: string, form: (lock: ccc.Script, text: string) => ccc.Transaction = proofTemplate) {
  const { signer, lock } = await signers[name]();
  const text = textFor(lock, nonce);
  const tx = await signer.signOnlyTransaction(await signer.prepareTransaction(form(lock, text)));
  return { lock, text, tx };
}
const opts = (text: string) => ({ rpcUrl: RPC_URL, runLock: runLock!, expect: expectFor(text, { now: new Date() }) });
const show = (r: Awaited<ReturnType<typeof verify>>) => (r.ok ? `ACCEPTED, cycles ${r.cycles}` : `REFUSED, ${r.reason}`);

for (const name of Object.keys(signers)) {
  test(`${name}: the signed proof verifies; a flipped signature bit does not`, { skip: NO_VM }, async (t) => {
    const { lock, text, tx } = await signed(name, `v1-${name}`);
    assert.equal(tx.witnesses.length, 1);
    const r = await verify({ lock, message: text, tx }, opts(text));
    // A bit inside the signature: the last byte of the witness is inside WitnessArgs.lock here.
    const bad = await verify({ lock, message: text, tx: flipWitnessByte(tx, ccc.bytesFrom(tx.witnesses[0]).length - 10) }, opts(text));
    t.diagnostic(`${show(r)}; flipped: ${show(bad)}`);
    assert.equal(r.ok, true);
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.reason : "", /^lock exited/);
  });

  test(`${name}: a proof signed in the earlier form is refused before the lock runs`, { skip: NO_VM }, async (t) => {
    const { lock, text, tx } = await signed(name, `v0-${name}`, earlierForm);
    // Control: the key did sign it. Run directly, the lock opens for the earlier form's transaction.
    const direct = await runLock!(mockTransaction(tx, proofInput(lock), await resolveCellDeps(RPC_URL, tx.cellDeps)));
    assert.equal(direct.code, 0);
    const r = await verify({ lock, message: text, tx }, { ...opts(text), runLock: async () => assert.fail("no lock run") });
    t.diagnostic(`lock run directly: exit ${direct.code}; verifier: ${show(r)}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /not the proof template/);
  });

  test(`${name}: a witness signed for one form does not open the other form's transaction`, { skip: NO_VM }, async (t) => {
    const forms = { current: proofTemplate, earlier: earlierForm };
    for (const [from, to] of [["current", "earlier"], ["earlier", "current"]] as const) {
      const { lock, text, tx } = await signed(name, `cross-${from}-${name}`, forms[from]);
      const other = forms[to](lock, text);
      other.cellDeps = tx.cellDeps.map((d) => d.clone());
      other.witnesses = [...tx.witnesses];
      const deps = await resolveCellDeps(RPC_URL, tx.cellDeps);
      const own = await runLock!(mockTransaction(tx, proofInput(lock), deps));
      const moved = await runLock!(mockTransaction(other, proofInput(lock), deps));
      t.diagnostic(`signed for the ${from} form: exit ${own.code}; placed on the ${to} form: exit ${moved.code}`);
      assert.equal(own.code, 0);
      assert.notEqual(moved.code, 0);
      assert.notEqual(moved.code, null);
    }
  });
}

test("anyone-can-pay: nobody proves the lock without the key", { skip: NO_VM }, async (t) => {
  // The output under the same lock is what anyone-can-pay looks at. It holds less than the input
  // (u64::MAX), so the lock asks for the signature. Witnesses a stranger can write are refused.
  const { lock, text, tx } = await signed("anyone-can-pay", "acp-open");
  for (const [about, witness] of [["no witness bytes", "0x"], ["an empty WitnessArgs", ccc.hexFrom(ccc.WitnessArgs.from({}).toBytes())], ["a zero signature", ccc.hexFrom(ccc.WitnessArgs.from({ lock: `0x${"00".repeat(65)}` }).toBytes())]] as const) {
    const forged = tx.clone();
    forged.witnesses = [witness];
    const r = await verify({ lock, message: text, tx: forged }, { ...opts(text), probes: false });
    t.diagnostic(`${about}: ${show(r)}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /^lock exited/);
  }
  // Control: the same transaction with the owner's signature is accepted.
  const r = await verify({ lock, message: text, tx }, opts(text));
  assert.equal(r.ok, true);
});
