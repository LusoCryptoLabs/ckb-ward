// V10, a JoyID sub key. Its proof lists the account's CoTA cell, which holds the root of the sub key
// list. On 2026-11-06 adding the device spent the cell whose root was all zero and made the one the
// proof lists. With the list as it was before, the same proof must not open the lock.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { depsLiveAt, jsonRpc, mockTransaction, proofInput, resolveCellDeps, verify } from "../src/index.ts";
import { NO_NETWORK, NO_VM, RPC_URL, expectFor, runLockFor, vectors } from "./helpers.ts";

const v = vectors.find((x) => x.file === "joyid-subkey.json")!;
const COTA_NOW = "0x25bcc222f265419ebfb449f4849da33c1b03fa7cb7d8eea82ed0105336e20c4d";
const COTA_BEFORE = { txHash: "0x5406dae922943df98f8ca5783bcf94468af044417cad4f900bf83d808a0d4862", index: 1 };
const ROOT_BEFORE = `0x02${"00".repeat(32)}`;

test("JoyID sub key: the proof lists the account's CoTA cell first", () => {
  assert.equal(ccc.Transaction.from(v.tx).cellDeps[0].outPoint.txHash, COTA_NOW);
});

test("JoyID sub key: with the sub key list from before the device was added, the lock refuses", { skip: NO_VM }, async (t) => {
  const tx = ccc.Transaction.from(v.tx);
  const lock = ccc.Script.from(v.lock);
  const deps = await resolveCellDeps(RPC_URL, tx.cellDeps);
  const now = await runLockFor(v)!(mockTransaction(tx, proofInput(lock), deps));
  const before = deps.map((d) => (d.cell_dep.out_point.tx_hash === COTA_NOW ? { ...d, data: ROOT_BEFORE } : d));
  const old = await runLockFor(v)!(mockTransaction(tx, proofInput(lock), before));
  t.diagnostic(`list now: exit ${now.code}; list before the device: exit ${old.code}`);
  assert.equal(now.code, 0);
  assert.equal(old.code, 13);
});

test("JoyID sub key: a proof listing the spent CoTA cell is refused before the lock runs", { skip: NO_NETWORK }, async () => {
  const tx = ccc.Transaction.from(v.tx).clone();
  tx.cellDeps[0] = ccc.CellDep.from({ outPoint: COTA_BEFORE, depType: "code" });
  const r = await verify({ lock: v.lock, message: v.message, tx }, { rpcUrl: RPC_URL, runLock: async () => assert.fail("no lock run"), expect: expectFor(v.message) });
  assert.match(!r.ok ? r.reason : "", /^cell dep 0x5406dae9[0-9a-f]{56}:1 is not live/);
});

test("JoyID sub key: a binding made before the device was added stops counting from that block", { skip: NO_NETWORK }, async () => {
  const added = BigInt((await jsonRpc(RPC_URL)("get_transaction", [COTA_NOW])).tx_status.block_number);
  const before = await depsLiveAt(RPC_URL, [COTA_BEFORE], added - 1n);
  const after = await depsLiveAt(RPC_URL, [COTA_BEFORE], added);
  assert.equal(before.live, true);
  assert.equal(after.live, false);
  assert.equal(after.deps[0].spentAt, added);
});
