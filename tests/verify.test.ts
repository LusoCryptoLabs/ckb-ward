// Offline: verify() refuses before touching the network or the VM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { verify, type Expect, type RunLock, type VerifyOptions } from "../src/index.ts";
import { expectFor, vectors } from "./helpers.ts";

const never: RunLock = async () => {
  throw new Error("the lock must not run");
};
const UNREACHABLE = "http://127.0.0.1:1/unreachable";
const v = vectors.find((x) => x.file === "secp256k1.json")!;
const other = vectors.find((x) => x.file === "joyid.json")!;
const proof = { lock: v.lock, message: v.message, tx: v.tx };
const opts = (expect: Partial<Expect> = {}, extra: Partial<VerifyOptions> = {}): VerifyOptions => ({ rpcUrl: UNREACHABLE, runLock: never, expect: expectFor(v.message, expect), ...extra });

const reason = async (p: Parameters<typeof verify>[0], o: VerifyOptions = opts()) => {
  const r = await verify(p, o);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.reason;
};

test("expect is required, every field of it", async () => {
  assert.equal(await reason(proof, { rpcUrl: UNREACHABLE, runLock: never } as unknown as VerifyOptions), "expect is required");
  for (const k of ["message", "domain", "account", "nonce", "chain", "maxAgeSeconds"] as const) {
    const e: Partial<Expect> = expectFor(v.message);
    delete e[k];
    assert.equal(await reason(proof, { rpcUrl: UNREACHABLE, runLock: never, expect: e as Expect }), `expect.${k} is required`);
  }
  assert.equal(await reason(proof, opts({ maxAgeSeconds: Number.NaN })), "expect.maxAgeSeconds is required");
});

test("a proof offered for another lock", async () => {
  assert.equal(await reason({ ...proof, lock: other.lock }), "message names another lock");
});

test("the message must be the one issued, byte for byte", async () => {
  // A prover who moves "Issued at" forward to stretch an old nonce, or swaps the lock line.
  const later = v.message.replace("Issued at: 2026-11-04T18:00:00Z", "Issued at: 2026-11-04T18:09:00Z");
  assert.equal(await reason({ ...proof, message: later }, opts()), "message is not the one issued");
  assert.equal(await reason({ ...proof, message: other.message, lock: other.lock }, opts()), "message is not the one issued");
});

test("platform checks: domain, account, nonce, chain, age", async () => {
  // Reached only when the stored message and the platform's own settings disagree.
  assert.equal(await reason(proof, opts({ domain: "other.example" })), "message is for another domain");
  assert.equal(await reason(proof, opts({ account: "user-43" })), "message is for another account");
  assert.equal(await reason(proof, opts({ nonce: "a1b2c4" })), "message has another nonce");
  assert.equal(await reason(proof, opts({ chain: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5" })), "message names another chain");
  const issued = Date.parse("2026-11-04T18:00:00Z");
  const at = (s: number) => opts({ now: new Date(issued + s * 1000) });
  assert.equal(await reason(proof, at(601)), "message expired");
  assert.equal(await reason(proof, at(-61)), "message issued in the future");
  await assert.rejects(verify(proof, at(600)), /fetch failed|ECONNREFUSED/, "inside the window it goes on to the chain");
});

test("claimNonce runs once, after the free checks and before any chain read", async () => {
  const calls: string[] = [];
  const claim = (ok: boolean) => (f: { nonce: string }) => (calls.push(f.nonce), ok);
  assert.equal(await reason(proof, opts({}, { claimNonce: claim(false) })), "nonce already used");
  assert.deepEqual(calls, ["a1b2c3"]);
  // A proof refused by a free check never claims the nonce.
  assert.equal(await reason({ ...proof, lock: other.lock }, opts({}, { claimNonce: claim(true) })), "message names another lock");
  assert.deepEqual(calls, ["a1b2c3"]);
  // Claimed, it goes on to the chain.
  await assert.rejects(verify(proof, opts({}, { claimNonce: claim(true) })), /fetch failed|ECONNREFUSED/);
  assert.deepEqual(calls, ["a1b2c3", "a1b2c3"]);
});

test("a second witness", async () => {
  const tx = ccc.Transaction.from(v.tx);
  tx.witnesses.push("0x");
  assert.equal(await reason({ ...proof, tx }), "exactly one witness expected");
});

test("a malformed message", async () => {
  assert.match(await reason({ ...proof, message: v.message + "\n" }, opts({ message: v.message + "\n" })), /^malformed proof/);
});
