// A since or header deps carried in the proof. The verifier copies them from the submitted
// transaction (like cell deps), so the template check accepts them, resolves header deps live, and
// bounds them. A lock that gates on a matured absolute since, or that reads a header, can then be
// proven; the probes still refuse a lock that is not exclusive. Nothing is sent.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { message, MAX_HEADER_DEPS, proofTemplate, resolveHeaders, verify, type RunLock } from "../src/index.ts";
import { headerLock, sinceLock } from "./elf.ts";
import { NO_DEBUGGER, NO_VM, RPC_URL, expectFor, runLock } from "./helpers.ts";
import { startStub, TESTNET_GENESIS } from "./stub.ts";

const owner = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" });
const never: RunLock = async () => {
  throw new Error("the lock must not run");
};

async function fabricate(stub: Awaited<ReturnType<typeof startStub>>, bin: Uint8Array) {
  const dep = ccc.CellDep.from({ outPoint: stub.fabricate({ capacity: BigInt(bin.length + 100) * 100000000n, lock: owner, data: bin }, "opt"), depType: "code" });
  const lock = ccc.Script.from({ codeHash: ccc.hashCkb(bin), hashType: "data1", args: "0x" });
  return { dep, lock };
}

test("a matured absolute since in the proof makes a time-gated lock provable", { skip: NO_DEBUGGER }, async (t) => {
  const stub = await startStub();
  try {
    const { dep, lock } = await fabricate(stub, sinceLock(100)); // requires input since >= 100
    const build = (since: bigint) => {
      const text = message({ domain: "dao.example", account: "tl", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: `n-${since}` });
      const tx = proofTemplate(lock, text, { since });
      tx.cellDeps = [dep];
      tx.witnesses = ["0x"];
      return { proof: { lock, message: text, tx }, text };
    };
    const opts = (text: string, probes?: boolean) => ({ rpcUrl: stub.url, runLock: runLock!, expect: expectFor(text, { now: new Date() }), probes });

    // Carried since satisfies the lock: the template check accepts it and the lock runs (probes off to
    // isolate the since; this lock reads no signature, so with probes on it is refused as not exclusive).
    const ok = build(100n);
    const rOk = await verify(ok.proof, opts(ok.text, false));
    t.diagnostic(`since 100, probes off: ${rOk.ok ? `ACCEPTED, cycles ${rOk.cycles}` : rOk.reason}`);
    assert.equal(rOk.ok, true);

    // since 0 (the old template default) is refused by the lock, not by the template check.
    const low = build(0n);
    const rLow = await verify(low.proof, opts(low.text, false));
    assert.equal(!rLow.ok && rLow.reason, "lock exited 24");

    // With the probes on, a lock that opens on since alone is still refused: no exclusive control.
    const guarded = build(100n);
    const rGuard = await verify(guarded.proof, opts(guarded.text));
    assert.equal(!rGuard.ok && rGuard.reason, "no exclusive control: the lock opens with an empty witness");
  } finally {
    await stub.close();
  }
});

test("a header dep in the proof is resolved live and a header-reading lock can run", { skip: NO_VM }, async (t) => {
  const header = (await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_tip_header", params: [] }) })).json()).result as { hash: string };
  const stub = await startStub({ upstream: RPC_URL });
  try {
    const { dep, lock } = await fabricate(stub, headerLock());
    const withText = message({ domain: "dao.example", account: "hd", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: "n-with" });
    const withTx = proofTemplate(lock, withText, { headerDeps: [header.hash] });
    withTx.cellDeps = [dep];
    withTx.witnesses = ["0x"];
    const rWith = await verify({ lock, message: withText, tx: withTx }, { rpcUrl: stub.url, runLock: runLock!, expect: expectFor(withText, { now: new Date() }), probes: false });
    t.diagnostic(`with a header dep, probes off: ${rWith.ok ? "ACCEPTED" : rWith.reason}`);
    assert.equal(rWith.ok, true);

    // Control: no header dep, so the lock cannot load one.
    const noText = message({ domain: "dao.example", account: "hd", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: "n-no" });
    const noTx = proofTemplate(lock, noText);
    noTx.cellDeps = [dep];
    noTx.witnesses = ["0x"];
    const rNo = await verify({ lock, message: noText, tx: noTx }, { rpcUrl: stub.url, runLock: runLock!, expect: expectFor(noText, { now: new Date() }), probes: false });
    assert.equal(!rNo.ok && rNo.reason, "lock exited 7");
  } finally {
    await stub.close();
  }
});

test("header deps are bounded before any chain read", async () => {
  const lock = ccc.Script.from({ codeHash: `0x${"ab".repeat(32)}`, hashType: "data1", args: "0x" });
  const text = message({ domain: "dao.example", account: "b", lock, chain: TESTNET_GENESIS, issuedAt: "2026-11-04T18:00:00Z", nonce: "n-b" });
  const tx = proofTemplate(lock, text, { headerDeps: Array.from({ length: MAX_HEADER_DEPS + 1 }, (_, i) => ccc.hexFrom(new Uint8Array(32).fill(i + 1))) });
  tx.witnesses = ["0x"];
  const r = await verify({ lock, message: text, tx }, { rpcUrl: "http://127.0.0.1:1/unreachable", runLock: never, expect: expectFor(text) });
  assert.equal(!r.ok && r.reason, "too many header deps");
});

test("resolveHeaders reads each header once and refuses an unknown one", { skip: NO_VM }, async () => {
  const tip = (await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_tip_header", params: [] }) })).json()).result as { hash: string };
  const got = await resolveHeaders(RPC_URL, [tip.hash, tip.hash]); // duplicate read once
  assert.equal(got.length, 1);
  await assert.rejects(resolveHeaders(RPC_URL, [`0x${"00".repeat(32)}`]), /is not live/);
});
