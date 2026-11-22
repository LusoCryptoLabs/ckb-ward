// Form 2 of the proof (SPEC section 4): the input names output 0 of a synthetic previous
// transaction, so a signer that checks every input against the transaction its hash names can
// follow it. Form 1 keeps working. The offline tests need no node and no VM; the others replay
// the signed proofs of tests/vectors-v2 like vectors.test.ts does, with controls.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { PROOF_INDEX, PROOF_INPUT_CAPACITY, PROOF_TAG_V2, mockTransaction, proofInput, proofPrevious, proofTemplate, proofVersionOf, readProof, resolveCellDeps, verify } from "../src/index.ts";
import { message, type RunLock } from "../src/index.ts";
import { password } from "./elf.ts";
import { NO_DEBUGGER, NO_NETWORK, NO_VM, expectFor, flipWitnessByte, otherMessage, poolAccept, rpcFor, runLock, runLockFor, vectors } from "./helpers.ts";
import { TESTNET_GENESIS, startStub } from "./stub.ts";

interface V2 {
  file: string;
  name: string;
  network?: "testnet" | "mainnet";
  lock: ccc.ScriptLike;
  message: string;
  tx: ccc.TransactionLike;
  signatureByte: number;
  otherMessageExit: number;
  signatureFlipExit: number;
  controls?: Record<string, { about: string; exit?: number; tx: ccc.TransactionLike }>;
}
const DIR = new URL("./vectors-v2/", import.meta.url);
const v2: V2[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));
const secp = v2.find((v) => v.file === "secp256k1.json")!;
const utf8 = (s: string) => ccc.bytesFrom(s, "utf8");

test("there is a signed form 2 proof for each software key lock", () => {
  assert.equal(v2.length, 12);
  for (const v of v2) assert.equal(JSON.parse(readFileSync(new URL(v.file, DIR), "utf8")).version, 2, v.file);
});

test("a form 2 proof is read as form 2, a form 1 proof as form 1, and a wallet reads both", () => {
  for (const v of v2) {
    const tx = ccc.Transaction.from(v.tx);
    assert.equal(tx.inputs[0].previousOutput.index, 0n, `${v.file}: output 0 of the previous transaction`);
    assert.equal(tx.inputs[0].previousOutput.txHash, proofPrevious(v.lock, v.message).hash(), `${v.file}: names the synthetic previous transaction`);
    assert.equal(proofVersionOf(v.lock, v.message, tx), 2, v.file);
    assert.ok(readProof(tx, v.lock), `${v.file}: readProof`);
  }
  for (const v of vectors) {
    const tx = ccc.Transaction.from(v.tx);
    assert.equal(tx.inputs[0].previousOutput.index, BigInt(PROOF_INDEX));
    assert.equal(proofVersionOf(v.lock, v.message, tx), 1, v.file);
  }
});

test("form 2 differs from form 1 in the input and nothing else", () => {
  const one = proofTemplate(secp.lock, secp.message);
  const two = proofTemplate(secp.lock, secp.message, { version: 2 });
  assert.notEqual(one.inputs[0].previousOutput.txHash, two.inputs[0].previousOutput.txHash);
  assert.equal(two.inputs[0].previousOutput.index, 0n);
  assert.equal(ccc.hexFrom(two.outputs[0].toBytes()), ccc.hexFrom(one.outputs[0].toBytes()), "the same output");
  assert.equal(two.outputsData[0], one.outputsData[0], "the same message");
  assert.equal(two.version, one.version);
  assert.equal(two.inputs[0].since, one.inputs[0].since);
  assert.equal(ccc.hexFrom(two.inputs[0].cellOutput!.toBytes()), ccc.hexFrom(one.inputs[0].cellOutput!.toBytes()), "the lock sees the same input cell");
});

test("the synthetic previous transaction binds the tag, the lock and the message, and can never be committed", () => {
  const lock = ccc.Script.from(secp.lock);
  const prev = proofPrevious(lock, secp.message);
  assert.equal(prev.inputs.length, 0, "no inputs: a node refuses it");
  assert.equal(prev.outputs[0].capacity, PROOF_INPUT_CAPACITY);
  assert.ok(prev.outputs[0].lock.eq(lock) && !prev.outputs[0].type);
  assert.equal(prev.outputsData[0], "0x", "the proof input's cell has no data");
  assert.equal(prev.outputsData[1], ccc.hexFrom(ccc.bytesConcat(utf8(PROOF_TAG_V2), lock.hash(), utf8(secp.message))));
  assert.equal(prev.outputs[1].capacity, BigInt(8 + lock.occupiedSize + ccc.bytesFrom(prev.outputsData[1]).length) * 100000000n, "the capacity its data occupies, not a value the parser fills in");
  // Another message or another lock gives another previous transaction.
  assert.notEqual(proofPrevious(lock, otherMessage(secp.message)).hash(), prev.hash());
  assert.notEqual(proofPrevious(ccc.Script.from({ ...lock, args: "0x" + "11".repeat(20) }), secp.message).hash(), prev.hash());
});

// A strict signer, as ccc#641 describes it: every input comes with the transaction its tx hash names,
// and the cell the host claims is that transaction's output at the index.
function strictSigner(tx: ccc.Transaction, claimed: ccc.CellOutput[], prevs: ccc.Transaction[]): string {
  for (const [i, input] of tx.inputs.entries()) {
    const prev = prevs.find((p) => p.hash() === input.previousOutput.txHash);
    if (!prev) return `input ${i}: no transaction hashes to ${input.previousOutput.txHash.slice(0, 12)}`;
    const out = prev.outputs[Number(input.previousOutput.index)];
    if (!out) return `input ${i}: the previous transaction has no output ${input.previousOutput.index}`;
    if (ccc.hexFrom(out.toBytes()) !== ccc.hexFrom(claimed[i].toBytes())) return `input ${i}: the claimed cell differs`;
  }
  return "ACCEPTED";
}

test("a strict signer refuses form 1 and follows form 2", () => {
  for (const v of v2) {
    const lock = ccc.Script.from(v.lock);
    const claimed = [ccc.CellOutput.from({ capacity: PROOF_INPUT_CAPACITY, lock })];
    const two = ccc.Transaction.from(v.tx);
    assert.equal(strictSigner(two, claimed, [proofPrevious(lock, v.message)]), "ACCEPTED", `${v.file}: form 2 with its previous transaction`);
    // Controls: the host hands the previous transaction of another message; the host claims a cell under another lock.
    assert.match(strictSigner(two, claimed, [proofPrevious(lock, otherMessage(v.message))]), /no transaction hashes/, `${v.file}: another message's previous transaction`);
    const other = [ccc.CellOutput.from({ capacity: PROOF_INPUT_CAPACITY, lock: ccc.Script.from({ ...lock, args: "0x" + "22".repeat(20) }) })];
    assert.match(strictSigner(two, other, [proofPrevious(lock, v.message)]), /the claimed cell differs/, `${v.file}: a cell under another lock`);
    // Form 1 of the same message: no transaction hashes to its out point, whatever the host hands over.
    const one = proofTemplate(lock, v.message);
    assert.match(strictSigner(one, claimed, [proofPrevious(lock, v.message)]), /no transaction hashes/, `${v.file}: form 1`);
  }
});

// What verify() refuses before it reads the chain, with the claim callback as the witness that a proof got past every free check.
async function reaches(v: { lock: ccc.ScriptLike; message: string }, tx: ccc.TransactionLike) {
  let claimed = false;
  const r = await verify({ lock: v.lock, message: v.message, tx }, {
    rpcUrl: "http://127.0.0.1:1",
    runLock: async () => ({ code: 0, output: "" }),
    expect: expectFor(v.message),
    claimNonce: () => {
      claimed = true;
      return false;
    },
  });
  return { claimed, reason: r.ok ? "ACCEPTED" : r.reason };
}
const plain = (tx: ccc.TransactionLike) => JSON.parse(JSON.stringify(tx));

test("form 1 and form 2 are told apart by the bytes, and anything in between is refused", async () => {
  const same = await reaches(secp, plain(secp.tx));
  assert.deepEqual(same, { claimed: true, reason: "nonce already used" }, "control: the form 2 proof passes every free check");
  const v1 = vectors.find((x) => x.file === "secp256k1.json")!;
  assert.equal((await reaches(v1, plain(v1.tx))).claimed, true, "control: the form 1 proof still does");
  const refused = "not the proof template for this lock and message";
  const edit = (f: (t: any) => void) => {
    const t = plain(secp.tx);
    f(t);
    return t;
  };
  // Form 2's hash with form 1's index, form 2's index with another message's hash, form 1's out point with form 2's index.
  assert.equal((await reaches(secp, edit((t) => (t.inputs[0].previousOutput.index = "0xffffffff")))).reason, refused);
  assert.equal((await reaches(secp, edit((t) => (t.inputs[0].previousOutput.txHash = proofPrevious(secp.lock, otherMessage(secp.message)).hash())))).reason, refused);
  assert.equal((await reaches(secp, edit((t) => (t.inputs[0].previousOutput.index = "0x1")))).reason, refused);
  const one = plain(v1.tx);
  one.inputs[0].previousOutput.index = "0x0";
  assert.equal((await reaches(v1, one)).reason, refused);
  // The previous transaction's own hash of the form 1 message is not a form 2 input either.
  assert.equal((await reaches(secp, edit((t) => (t.inputs[0].previousOutput = plain(v1.tx).inputs[0].previousOutput)))).reason, refused);
});

test("a wallet is not fooled by a form 2 transaction for another lock", () => {
  const tx = ccc.Transaction.from(secp.tx);
  assert.ok(readProof(tx, secp.lock));
  assert.equal(readProof(tx, ccc.Script.from({ ...ccc.Script.from(secp.lock), args: "0x" + "33".repeat(20) })), undefined);
  const bent = tx.clone();
  bent.inputs[0].previousOutput = ccc.OutPoint.from({ txHash: proofPrevious(secp.lock, otherMessage(secp.message)).hash(), index: 0 });
  assert.equal(readProof(bent, secp.lock), undefined);
});

// ---- with the VM and the chain, like tests/vectors.test.ts

const options = (v: V2, message: string) => ({ rpcUrl: rpcFor(v), runLock: runLockFor(v)!, expect: expectFor(message) });
const STALE = /cell dep 0x[0-9a-f]{64}:\d+ is not live/;
const stale = new Map<string, Promise<string | null>>();
const staleReason = (v: V2) => {
  if (!stale.has(v.file)) stale.set(v.file, resolveCellDeps(rpcFor(v), ccc.Transaction.from(v.tx).cellDeps).then(() => null, (e) => (e instanceof Error && STALE.test(e.message) ? e.message : null)));
  return stale.get(v.file)!;
};
const direct = async (v: V2, tx: ccc.Transaction) => runLockFor(v)!(mockTransaction(tx, proofInput(ccc.Script.from(v.lock)), await resolveCellDeps(rpcFor(v), tx.cellDeps)));

for (const v of v2) {
  const proof = { lock: v.lock, message: v.message, tx: v.tx };

  test(`${v.name}: form 2 accepted, with the probes`, { skip: NO_VM }, async (t) => {
    const s = await staleReason(v);
    if (s) return t.skip(s);
    const r = await verify(proof, options(v, v.message));
    t.diagnostic(r.ok ? `ACCEPTED, cycles ${r.cycles}` : `REFUSED, ${r.reason}`);
    assert.equal(r.ok, true);
  });

  test(`${v.name}: control, another message, one bit flipped, an empty witness`, { skip: NO_VM }, async (t) => {
    const s = await staleReason(v);
    if (s) return t.skip(s);
    const other = await verify({ ...proof, message: otherMessage(v.message) }, options(v, otherMessage(v.message)));
    assert.equal(!other.ok && other.reason, "not the proof template for this lock and message");
    // The lock refuses the same witness on the other message's form 2 template.
    const tpl = proofTemplate(v.lock, otherMessage(v.message), { version: 2 });
    tpl.cellDeps = ccc.Transaction.from(v.tx).cellDeps;
    tpl.witnesses = ccc.Transaction.from(v.tx).witnesses;
    assert.equal((await direct(v, tpl)).code, v.otherMessageExit);
    const flipped = await verify({ ...proof, tx: flipWitnessByte(v.tx, v.signatureByte) }, options(v, v.message));
    assert.equal(!flipped.ok && flipped.reason, `lock exited ${v.signatureFlipExit}`);
    const empty = ccc.Transaction.from(v.tx).clone();
    empty.witnesses = ["0x"];
    assert.notEqual((await direct(v, empty)).code, 0);
  });

  test(`${v.name}: a signature of one form does not open the other form`, { skip: NO_VM }, async (t) => {
    const s = await staleReason(v);
    if (s) return t.skip(s);
    // The same lock, message and witness on the form 1 template: the transaction hash differs, so the lock refuses it.
    const tx2 = ccc.Transaction.from(v.tx);
    const asOne = proofTemplate(v.lock, v.message);
    asOne.cellDeps = tx2.cellDeps;
    asOne.witnesses = tx2.witnesses;
    const r1 = await direct(v, asOne);
    t.diagnostic(`form 2 witness on the form 1 template: exit ${r1.code}`);
    assert.notEqual(r1.code, 0);
    // And the form 1 signature on the form 2 template.
    const one = vectors.find((x) => x.file === v.file);
    if (one) {
      const tx1 = ccc.Transaction.from(one.tx);
      const asTwo = proofTemplate(one.lock, one.message, { version: 2 });
      asTwo.cellDeps = tx1.cellDeps;
      asTwo.witnesses = tx1.witnesses;
      assert.notEqual((await direct({ ...v, lock: one.lock }, asTwo)).code, 0, "form 1 witness on the form 2 template");
    }
  });

  for (const [name, c] of Object.entries(v.controls ?? {})) {
    test(`${v.name}: control, ${name}`, { skip: NO_VM }, async (t) => {
      const s = await staleReason(v);
      if (s) return t.skip(s);
      const r = await verify({ ...proof, tx: c.tx }, options(v, v.message));
      t.diagnostic(r.ok ? "ACCEPTED" : r.reason);
      assert.equal(!r.ok && r.reason, `lock exited ${c.exit}`);
    });
  }

  test(`${v.name}: the node refuses the signed form 2 proof (the input names a transaction that is not on chain)`, { skip: NO_NETWORK }, async (t) => {
    const e = await poolAccept(v.tx, rpcFor(v));
    t.diagnostic(e);
    assert.match(e, /Unknown\(OutPoint\(0x[0-9a-f]{64}00000000\)\)/);
  });
}

test("the node refuses the synthetic previous transaction itself", { skip: NO_NETWORK }, async (t) => {
  const e = await poolAccept(proofPrevious(secp.lock, secp.message), rpcFor(secp));
  t.diagnostic(e);
  assert.notEqual(e, "ACCEPTED");
  assert.match(e, /Empty|empty/);
});

test("the second probe is built in the form of the proof", { skip: NO_DEBUGGER }, async () => {
  // A password lock opens for the same witness on another message, so the probe runs; a spy records the
  // out point index of the input of every lock run: the proof, probe (a) and probe (b).
  const owner = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" });
  const stub = await startStub();
  try {
    const bin = password("open");
    const dep = ccc.CellDep.from({ outPoint: stub.fabricate({ capacity: BigInt(bin.length + 100) * 100000000n, lock: owner, data: bin }, "v2-probe"), depType: "code" });
    const lock = ccc.Script.from({ codeHash: ccc.hashCkb(bin), hashType: "data1", args: "0x" });
    const seen = async (version: 1 | 2) => {
      const text = message({ domain: "dao.example", account: `acct-${version}`, lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: `n-${version}` });
      const tx = proofTemplate(lock, text, { version });
      tx.cellDeps = [dep];
      tx.witnesses = [ccc.hexFrom(ccc.bytesFrom("open", "utf8"))];
      const indexes: string[] = [];
      const spy: RunLock = async (mock) => {
        indexes.push((mock.tx as { inputs: { previous_output: { index: string } }[] }).inputs[0].previous_output.index);
        return runLock!(mock);
      };
      const r = await verify({ lock, message: text, tx }, { rpcUrl: stub.url, runLock: spy, expect: expectFor(text, { now: new Date() }) });
      assert.equal(!r.ok && r.reason, "no exclusive control: the same witness opens another message", `form ${version}`);
      return indexes;
    };
    assert.deepEqual(await seen(1), ["0xffffffff", "0xffffffff", "0xffffffff"], "form 1: the proof and both probes");
    assert.deepEqual(await seen(2), ["0x0", "0x0", "0x0"], "form 2: the proof and both probes");
  } finally {
    await stub.close();
  }
});
