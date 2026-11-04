// Offline: verify() refuses before touching the network or the VM.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { verify, type RunLock } from "../src/index.ts";
import { vectors } from "./helpers.ts";

const never: RunLock = async () => {
  throw new Error("the lock must not run");
};
const opts = { rpcUrl: "http://127.0.0.1:1/unreachable", runLock: never };
const v = vectors.find((x) => x.file === "secp256k1-a.json")!;
const other = vectors.find((x) => x.file === "joyid-a.json")!;
const proof = { lock: v.lock, message: v.message, tx: v.tx, variant: "A" as const };

const reason = async (p: Parameters<typeof verify>[0], o: Parameters<typeof verify>[1] = opts) => {
  const r = await verify(p, o);
  assert.equal(r.ok, false);
  return r.ok ? "" : r.reason;
};

test("a proof offered for another lock", async () => {
  assert.equal(await reason({ ...proof, lock: other.lock }), "message names another lock");
});

test("platform checks: domain, account, nonce, age", async () => {
  assert.equal(await reason(proof, { ...opts, expect: { domain: "other.example" } }), "message is for another domain");
  assert.equal(await reason(proof, { ...opts, expect: { account: "user-43" } }), "message is for another account");
  assert.equal(await reason(proof, { ...opts, expect: { nonce: "a1b2c4" } }), "message has another nonce");
  const issued = Date.parse("2026-11-04T18:00:00Z");
  const now = (s: number) => ({ ...opts, expect: { maxAgeSeconds: 600, now: new Date(issued + s * 1000) } });
  assert.equal(await reason(proof, now(601)), "message expired");
  assert.equal(await reason(proof, now(-61)), "message issued in the future");
  await assert.rejects(verify(proof, now(600)), /fetch failed|ECONNREFUSED/, "inside the window it goes on to the chain");
});

test("a second witness", async () => {
  const tx = ccc.Transaction.from(v.tx);
  tx.witnesses.push("0x");
  assert.equal(await reason({ ...proof, tx }), "exactly one witness expected");
});

test("an unknown variant and a malformed message", async () => {
  assert.equal(await reason({ ...proof, variant: "C" as "A" }), "unknown variant");
  assert.match(await reason({ ...proof, message: v.message + "\n" }), /^malformed proof/);
});
