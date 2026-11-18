// Version 1 of the signed bytes: the proof output is under the claimed lock, so a wallet reads from
// the transaction which of its locks is asked to sign. Version 0 (output under the null lock) stays
// valid. Offline tests for the template; with the network and a lock runner, proofs signed here
// with local keys, one control per claim.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { NULL_LOCK, PROOF_TAG, PROOF_TAG_V1, PROOF_VERSION, message, proofOutPoint, proofTemplate, proofVersion, readProof, verify, type ProofVersion } from "../src/index.ts";
import { NO_VM, RPC_URL, expectFor, flipWitnessByte, runLock, vectors, versionOf } from "./helpers.ts";
import { TESTNET_GENESIS } from "./stub.ts";

const VERSIONS: ProofVersion[] = [0, 1];
const lockA = ccc.Script.from({ codeHash: `0x${"aa".repeat(32)}`, hashType: "type", args: `0x${"01".repeat(20)}` });
const lockB = ccc.Script.from({ codeHash: `0x${"aa".repeat(32)}`, hashType: "type", args: `0x${"02".repeat(20)}` });
const textFor = (lock: ccc.Script, nonce: string) => message({ domain: "dao.example", account: "acct", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce });
const utf8 = (s: string) => ccc.bytesFrom(s, "utf8");

test("new proofs are version 1; the tags differ only in the version digit", () => {
  assert.equal(PROOF_VERSION, 1);
  assert.equal(PROOF_TAG, "CKB lock proof v0\n");
  assert.equal(PROOF_TAG_V1, "CKB lock proof v1\n");
  assert.equal(utf8(PROOF_TAG_V1).length, 18);
});

test("version 1: the output is under the claimed lock; version 0: under the null lock", () => {
  const text = textFor(lockA, "shape");
  const n = utf8(text).length;
  const v0 = proofTemplate(lockA, text, { version: 0 });
  const v1 = proofTemplate(lockA, text, { version: 1 });
  assert.ok(v0.outputs[0].lock.eq(NULL_LOCK));
  assert.equal(v0.outputs[0].capacity, BigInt(41 + n) * 100000000n);
  assert.ok(v1.outputs[0].lock.eq(lockA));
  // 8 of capacity, 32 + 1 + 20 of the lock, then the data: the output's occupied capacity.
  assert.equal(v1.outputs[0].capacity, BigInt(8 + 53 + n) * 100000000n);
  assert.equal(v1.outputs[0].type, undefined);
  assert.equal(v1.outputsData[0], ccc.hexFrom(utf8(text)));
  assert.ok(proofTemplate(lockA, text).hash() === v1.hash(), "the default is version 1");
  // Each version has its own out point and its own transaction hash.
  assert.equal(v0.inputs[0].previousOutput.txHash, ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG), lockA.hash(), utf8(text))));
  assert.equal(v1.inputs[0].previousOutput.txHash, ccc.hashCkb(ccc.bytesConcat(utf8(PROOF_TAG_V1), lockA.hash(), utf8(text))));
  assert.ok(proofOutPoint(lockA, text, 1).eq(v1.inputs[0].previousOutput));
  assert.notEqual(v0.hash(), v1.hash());
  // The input cell is the same in both: capacity u64::MAX, the claimed lock, no type, no data.
  for (const t of [v0, v1]) {
    assert.equal(t.inputs[0].cellOutput?.capacity, 2n ** 64n - 1n);
    assert.ok(t.inputs[0].cellOutput?.lock.eq(lockA));
  }
});

test("proofVersion and readProof tell the version, and refuse a mix of the two", () => {
  const text = textFor(lockA, "detect");
  for (const version of VERSIONS) {
    const tx = proofTemplate(lockA, text, { version });
    assert.equal(proofVersion(tx, lockA, text), version);
    assert.equal(readProof(tx, lockA)?.nonce, "detect");
    assert.equal(proofVersion(tx, lockB, text), undefined, "another lock");
    assert.equal(readProof(tx, lockB), undefined);
  }
  // Version 1 out point over a version 0 output, and the reverse.
  const mixA = proofTemplate(lockA, text, { version: 1 });
  mixA.outputs[0].lock = NULL_LOCK;
  assert.equal(proofVersion(mixA, lockA, text), undefined);
  const mixB = proofTemplate(lockA, text, { version: 0 });
  mixB.outputs[0].lock = lockA;
  assert.equal(proofVersion(mixB, lockA, text), undefined);
});

test("version 1: an output lock that is not the lock the out point commits to matches nobody", () => {
  // A site asks a wallet that holds lock A to sign: out point derived for lock B, output under A.
  const text = textFor(lockB, "swap");
  const tx = proofTemplate(lockB, text, { version: 1 });
  tx.outputs[0].lock = lockA;
  assert.equal(proofVersion(tx, lockA, text), undefined);
  assert.equal(proofVersion(tx, lockB, text), undefined);
  assert.equal(readProof(tx, lockA), undefined);
  assert.equal(readProof(tx, lockB), undefined);
  // Control: the untouched template is a proof for B.
  assert.equal(proofVersion(proofTemplate(lockB, text, { version: 1 }), lockB, text), 1);
});

test("each saved vector reads as a proof of the version it says; only two JoyID app vectors are still version 0", () => {
  for (const v of vectors) {
    assert.equal(proofVersion(v.tx, v.lock, v.message), versionOf(v), v.file);
  }
  assert.deepEqual(vectors.filter((v) => versionOf(v) === 0).map((v) => v.file).sort(), ["joyid-subkey.json", "mainnet-joyid.json"]);
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

async function signed(name: string, version: ProofVersion, nonce: string) {
  const { signer, lock } = await signers[name]();
  const text = textFor(lock, nonce);
  const tx = await signer.signOnlyTransaction(await signer.prepareTransaction(proofTemplate(lock, text, { version })));
  return { lock, text, tx };
}
const opts = (text: string) => ({ rpcUrl: RPC_URL, runLock: runLock!, expect: expectFor(text, { now: new Date() }) });
const show = (r: Awaited<ReturnType<typeof verify>>) => (r.ok ? `ACCEPTED v${r.version}, cycles ${r.cycles}` : `REFUSED, ${r.reason}`);

for (const name of Object.keys(signers)) {
  for (const version of VERSIONS) {
    test(`${name}, version ${version}: the signed proof verifies and reports its version; a flipped signature bit does not`, { skip: NO_VM }, async (t) => {
      const { lock, text, tx } = await signed(name, version, `v${version}-${name}`);
      assert.equal(tx.witnesses.length, 1);
      const r = await verify({ lock, message: text, tx }, opts(text));
      // A bit inside the signature: the last byte of the witness is inside WitnessArgs.lock here.
      const bad = await verify({ lock, message: text, tx: flipWitnessByte(tx, ccc.bytesFrom(tx.witnesses[0]).length - 10) }, opts(text));
      t.diagnostic(`${show(r)}; flipped: ${show(bad)}`);
      assert.equal(r.ok && r.version, version);
      assert.equal(bad.ok, false);
      assert.match(!bad.ok ? bad.reason : "", /^lock exited/);
    });
  }

  test(`${name}: a witness signed for one version does not open the other version's template`, { skip: NO_VM }, async (t) => {
    for (const [from, to] of [[1, 0], [0, 1]] as const) {
      const { lock, text, tx } = await signed(name, from, `cross-${from}-${name}`);
      const other = proofTemplate(lock, text, { version: to });
      other.cellDeps = tx.cellDeps.map((d) => d.clone());
      other.witnesses = [...tx.witnesses];
      const r = await verify({ lock, message: text, tx: other }, opts(text));
      t.diagnostic(`signed for v${from}, placed on v${to}: ${show(r)}`);
      assert.equal(r.ok, false);
      assert.match(!r.ok ? r.reason : "", /^lock exited/);
    }
  });
}

test("version 1, anyone-can-pay: nobody proves the lock without the key", { skip: NO_VM }, async (t) => {
  // The output under the same lock is what anyone-can-pay looks at. It holds less than the input
  // (u64::MAX), so the lock asks for the signature. Witnesses a stranger can write are refused.
  const { lock, text, tx } = await signed("anyone-can-pay", 1, "acp-open");
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
