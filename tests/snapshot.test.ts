// depsLiveAt: platform rule 8. A real case on testnet: the account-cell-type code cell of the
// Cellula names namespace, spent by an in-place upgrade on 2026-11-05. It was a cell dep of every
// name transaction until then, the shape a lock's code or settings cell has in a proof.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { depsLiveAt, jsonRpc, verify } from "../src/index.ts";
import { NO_NETWORK, NO_VM, RPC_URL, expectFor, runLock, vectors } from "./helpers.ts";

const UPGRADED = { txHash: "0xe3c204947c3f457410af242747146b3330a05d9f02d095b2636ac9368a3acce4", index: 0 };
const UPGRADE_TX = "0x1d791fd5f8edfa9199346ff8ec19d0d341a3adb4f43c26ea32a4d59b94fc1eab";

const blockOf = async (txHash: string) => BigInt((await jsonRpc(RPC_URL)("get_transaction", [txHash])).tx_status.block_number);

test("a cell spent by an upgrade: live the block before, not live from the upgrade's block", { skip: NO_NETWORK }, async (t) => {
  const spent = await blockOf(UPGRADE_TX);
  const before = await depsLiveAt(RPC_URL, [UPGRADED], spent - 1n);
  const atUpgrade = await depsLiveAt(RPC_URL, [UPGRADED], spent);
  t.diagnostic(`upgrade in block ${spent}: before ${before.deps[0].reason}; at it ${atUpgrade.deps[0].reason}`);
  assert.equal(before.live, true);
  assert.equal(before.deps[0].reason, "spent after the snapshot");
  assert.equal(atUpgrade.live, false);
  assert.equal(atUpgrade.deps[0].spentAt, spent);
});

test("a cell created after the snapshot is not live at it", { skip: NO_NETWORK }, async () => {
  const created = await blockOf(UPGRADE_TX);
  const r = await depsLiveAt(RPC_URL, [{ txHash: UPGRADE_TX, index: 0 }], created - 1n);
  assert.equal(r.live, false);
  assert.equal(r.deps[0].reason, `created in block ${created}, after the snapshot`);
  // Control: from its own block it is live (it is the current code cell).
  const own = await depsLiveAt(RPC_URL, [{ txHash: UPGRADE_TX, index: 0 }], created);
  assert.equal(own.live, true);
});

test("a real proof's cell deps, dep group members included, are live at the tip; one spent cell makes the binding not count", { skip: NO_VM }, async (t) => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const r = await verify({ lock: v.lock, message: v.message, tx: v.tx }, { rpcUrl: RPC_URL, runLock: runLock!, expect: expectFor(v.message) });
  assert.ok(r.ok);
  const tip = BigInt((await jsonRpc(RPC_URL)("get_tip_header", [])).number);
  const now = await depsLiveAt(RPC_URL, r.cellDeps, tip);
  t.diagnostic(`${r.cellDeps.length} cells: ${now.deps.map((d) => d.reason).join("; ")}`);
  assert.equal(now.live, true);
  const spent = await blockOf(UPGRADE_TX);
  const mixed = await depsLiveAt(RPC_URL, [...r.cellDeps, ccc.OutPoint.from(UPGRADED)], tip);
  assert.equal(mixed.live, false);
  assert.deepEqual(mixed.deps.filter((d) => !d.live).map((d) => d.spentAt), [spent]);
});

test("a snapshot past the tip is refused, not answered", { skip: NO_NETWORK }, async () => {
  const tip = BigInt((await jsonRpc(RPC_URL)("get_tip_header", [])).number);
  await assert.rejects(depsLiveAt(RPC_URL, [UPGRADED], tip + 1000n), /past the tip/);
});
