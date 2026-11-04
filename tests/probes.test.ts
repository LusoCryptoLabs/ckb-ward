// The "no exclusive control" probes. Locks assembled in tests/elf.ts, their code cells fabricated in
// the local stub, so this runs without the network (it needs the lock runner). Each refusal comes
// with its control: the same proof with the probes off is accepted, so the probe is what refuses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { message, proofTemplate, verify } from "../src/index.ts";
import { alwaysSuccess, password } from "./elf.ts";
import { NO_DEBUGGER, expectFor, runLock } from "./helpers.ts";
import { TESTNET_GENESIS, startStub, type Stub } from "./stub.ts";

const owner = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" });

async function proofFor(stub: Stub, bin: Uint8Array, account: string, witness: ccc.HexLike) {
  const dep = ccc.CellDep.from({ outPoint: stub.fabricate({ capacity: BigInt(bin.length + 100) * 100000000n, lock: owner, data: bin }, account), depType: "code" });
  const lock = ccc.Script.from({ codeHash: ccc.hashCkb(bin), hashType: "data1", args: "0x" });
  const text = message({ domain: "dao.example", account, lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: `n-${account}` });
  const tx = proofTemplate(lock, text);
  tx.cellDeps = [dep];
  tx.witnesses = [ccc.hexFrom(witness)];
  return { proof: { lock, message: text, tx }, expect: expectFor(text, { now: new Date() }) };
}

const show = (r: Awaited<ReturnType<typeof verify>>) => (r.ok ? `ACCEPTED, cycles ${r.cycles}` : `REFUSED, ${r.reason}`);

test("an always-success lock is refused: it opens with an empty witness", { skip: NO_DEBUGGER }, async (t) => {
  const stub = await startStub();
  try {
    const { proof, expect } = await proofFor(stub, alwaysSuccess(), "mallory", "0x");
    const on = await verify(proof, { rpcUrl: stub.url, runLock: runLock!, expect });
    const off = await verify(proof, { rpcUrl: stub.url, runLock: runLock!, expect, probes: false });
    t.diagnostic(`probes on: ${show(on)}; probes off: ${show(off)}`);
    assert.equal(!on.ok && on.reason, "no exclusive control: the lock opens with an empty witness");
    assert.equal(off.ok, true);
  } finally {
    await stub.close();
  }
});

test("a password lock is refused: the same witness opens another message", { skip: NO_DEBUGGER }, async (t) => {
  const stub = await startStub();
  try {
    const open = ccc.bytesFrom("open", "utf8");
    const { proof, expect } = await proofFor(stub, password("open"), "alice", open);
    const on = await verify(proof, { rpcUrl: stub.url, runLock: runLock!, expect });
    const off = await verify(proof, { rpcUrl: stub.url, runLock: runLock!, expect, probes: false });
    // The lock is not open to anyone: without the password it refuses.
    const empty = await proofFor(stub, password("open"), "mallory", "0x");
    const none = await verify(empty.proof, { rpcUrl: stub.url, runLock: runLock!, expect: empty.expect, probes: false });
    t.diagnostic(`probes on: ${show(on)}; probes off: ${show(off)}; empty witness, probes off: ${show(none)}`);
    assert.equal(!on.ok && on.reason, "no exclusive control: the same witness opens another message");
    assert.equal(off.ok, true);
    assert.equal(!none.ok && none.reason, "lock exited 2");
  } finally {
    await stub.close();
  }
});
