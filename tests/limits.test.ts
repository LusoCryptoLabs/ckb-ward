// What one proof can make the verifier do. Offline against the local stub, which counts chain reads;
// the lock runner is a stand-in that refuses, since only the work before it is measured. The last
// test checks the size limit against the real testnet node (test_tx_pool_accept, nothing enters
// the pool).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { MAX_TX_BYTES, MAX_WITNESS_BYTES, message, proofTemplate, verify, type RunLock, type VerifyOptions } from "../src/index.ts";
import { NO_NETWORK, expectFor, poolAccept, vectors } from "./helpers.ts";
import { TESTNET_GENESIS, startStub, type Stub } from "./stub.ts";

let runs = 0;
const refuse: RunLock = async () => (runs++, { code: 1, output: "" });
const lock = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x01" });
const text = message({ domain: "dao.example", account: "alice", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: "limits" });
const opts = (stub: Stub, extra: Partial<VerifyOptions> = {}): VerifyOptions => ({ rpcUrl: stub.url, runLock: refuse, expect: expectFor(text, { now: new Date() }), ...extra });

function proof(deps: ccc.CellDepLike[], witness: ccc.HexLike = "0x") {
  const tx = proofTemplate(lock, text);
  tx.cellDeps = deps.map((d) => ccc.CellDep.from(d));
  tx.witnesses = [ccc.hexFrom(witness)];
  return { lock, message: text, tx };
}
const code = (outPoint: ccc.OutPoint) => ({ outPoint, depType: "code" as const });
const group = (outPoint: ccc.OutPoint) => ({ outPoint, depType: "depGroup" as const });
const tiny = (stub: Stub, tag: string) => stub.fabricate({ capacity: 61n * 100000000n, lock }, tag);
function groupCell(stub: Stub, members: ccc.OutPoint[], tag: string) {
  const data = ccc.bytesConcat(ccc.numLeToBytes(members.length, 4), ...members.map((m) => m.toBytes()));
  return stub.fabricate({ capacity: BigInt(data.length + 61) * 100000000n, lock, data }, tag);
}
const reads = (stub: Stub) => stub.counts.get_live_cell ?? 0;

async function withStub(f: (stub: Stub) => Promise<void>, options = {}) {
  const stub = await startStub(options);
  try {
    await f(stub);
  } finally {
    await stub.close();
  }
}

test("17 cell deps, or one out point listed twice: refused before any chain read", () =>
  withStub(async (stub) => {
    const ops = Array.from({ length: 17 }, (_, i) => tiny(stub, `d${i}`));
    let r = await verify(proof(ops.map(code)), opts(stub));
    assert.equal(!r.ok && r.reason, "too many cell deps");
    r = await verify(proof([code(ops[0]), code(ops[1]), code(ops[0])]), opts(stub));
    assert.equal(!r.ok && r.reason, `cell dep ${ops[0].txHash}:0 is listed twice`);
    r = await verify(proof([code(ops[0]), group(ops[0])]), opts(stub));
    assert.equal(!r.ok && r.reason, `cell dep ${ops[0].txHash}:0 is listed twice`);
    assert.deepEqual(stub.counts, {});
    // Control: 16 distinct deps are read, each once, and the lock runs.
    runs = 0;
    r = await verify(proof(ops.slice(0, 16).map(code)), opts(stub));
    assert.equal(!r.ok && r.reason, "lock exited 1");
    assert.equal(reads(stub), 16);
    assert.equal(runs, 1);
  }));

test("dep groups listing more than 32 cells: refused from the groups' data, no member read", () =>
  withStub(async (stub) => {
    const members = Array.from({ length: 33 }, (_, i) => tiny(stub, `m${i}`));
    let r = await verify(proof([group(groupCell(stub, members, "g33"))]), opts(stub));
    assert.equal(!r.ok && r.reason, "cell dep groups list more than 32 cells");
    assert.equal(reads(stub), 1);
    // 16 + 17 across two groups: both group cells read, then refused.
    stub.resetCounts();
    r = await verify(proof([group(groupCell(stub, members.slice(0, 16), "g16")), group(groupCell(stub, members.slice(16), "g17"))]), opts(stub));
    assert.equal(!r.ok && r.reason, "cell dep groups list more than 32 cells");
    assert.equal(reads(stub), 2);
    // One group of 1000 (the reviewers' amplification case): one read.
    stub.resetCounts();
    r = await verify(proof([group(groupCell(stub, Array.from({ length: 1000 }, () => members[0]), "g1000"))]), opts(stub));
    assert.equal(!r.ok && r.reason, "cell dep groups list more than 32 cells");
    assert.equal(reads(stub), 1);
    // Control: exactly 32 members are all read and the lock runs.
    stub.resetCounts();
    runs = 0;
    r = await verify(proof([group(groupCell(stub, members.slice(0, 32), "g32"))]), opts(stub));
    assert.equal(!r.ok && r.reason, "lock exited 1");
    assert.equal(reads(stub), 33);
    assert.equal(runs, 1);
  }));

test("a member listed many times, or also listed directly, is read once", () =>
  withStub(async (stub) => {
    const m = tiny(stub, "m");
    const r = await verify(proof([code(m), group(groupCell(stub, Array.from({ length: 20 }, () => m), "g20"))]), opts(stub));
    assert.equal(!r.ok && r.reason, "lock exited 1");
    assert.equal(reads(stub), 2);
  }));

test("transaction and witness size limits, at the exact boundary", () =>
  withStub(async (stub) => {
    const deps = [code(tiny(stub, "d"))];
    const base = proof(deps).tx.toBytes().length + 4; // in-block size with an empty witness
    const sized = (inBlock: number) => proof(deps, new Uint8Array(inBlock - base));
    // claimNonce answers "used", so a proof that passes every free check stops right there.
    const used = { claimNonce: () => false, maxWitnessBytes: Number.POSITIVE_INFINITY };
    let r = await verify(sized(MAX_TX_BYTES + 1), opts(stub, used));
    assert.equal(!r.ok && r.reason, "transaction too large");
    r = await verify(sized(MAX_TX_BYTES), opts(stub, used));
    assert.equal(!r.ok && r.reason, "nonce already used");
    const w = (n: number) => proof(deps, new Uint8Array(n));
    r = await verify(w(MAX_WITNESS_BYTES + 1), opts(stub, { claimNonce: () => false }));
    assert.equal(!r.ok && r.reason, "witness too large");
    r = await verify(w(MAX_WITNESS_BYTES), opts(stub, { claimNonce: () => false }));
    assert.equal(!r.ok && r.reason, "nonce already used");
    assert.deepEqual(stub.counts, {});
  }));

test("each chain read times out", async () => {
  await withStub(
    async (stub) => {
      const t0 = Date.now();
      await assert.rejects(verify(proof([]), opts(stub, { rpcTimeoutMs: 100 })), (e: Error) => e.name === "TimeoutError");
      assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
      // Control: the same slow node within the timeout is read.
      runs = 0;
      const r = await verify(proof([]), opts(stub, { rpcTimeoutMs: 5000 }));
      assert.equal(!r.ok && r.reason, "lock exited 1");
    },
    { delayMs: 300 },
  );
});

test("the node draws the size line at the same byte", { skip: NO_NETWORK }, async (t) => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const tx = proofTemplate(v.lock, v.message);
  tx.cellDeps = ccc.Transaction.from(v.tx).cellDeps;
  tx.witnesses = ["0x"];
  const base = tx.toBytes().length + 4;
  const at = (inBlock: number) => {
    const c = tx.clone();
    c.witnesses = [ccc.hexFrom(new Uint8Array(inBlock - base))];
    return c;
  };
  const fits = await poolAccept(at(MAX_TX_BYTES));
  const over = await poolAccept(at(MAX_TX_BYTES + 1));
  t.diagnostic(`${MAX_TX_BYTES}: ${fits.slice(0, 110)}`);
  t.diagnostic(`${MAX_TX_BYTES + 1}: ${over.slice(0, 110)}`);
  assert.doesNotMatch(fits, /ExceededMaximumBlockBytes/);
  assert.match(over, /ExceededMaximumBlockBytes/);
});
