// daoWeightAt: platform rule 8, the weight of a lock at a snapshot block. A real history on testnet,
// made for these tests on 2026-11-06 with a key of its own: two deposits in one transaction
// (200 and 300 CKB), then phase 1 of a withdrawal of the 200 CKB one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { NERVOS_DAO_CODE_HASH, daoWeightAt, jsonRpc } from "../src/index.ts";
import { NO_NETWORK, RPC_URL } from "./helpers.ts";

const LOCK = ccc.Script.from({
  codeHash: "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8",
  hashType: "type",
  args: "0x8346bdc27e75417b9761947a3fb3baef42b80789",
});
const DEPOSITS_TX = "0x72067b401bbe8a7b7a3baf496dbb3eb232bbb8330eccba00b4674d00c1be8087";
const WITHDRAW_TX = "0xf9138c1cd8eae3bab560e071d1e72ed67b2c05b39a83b17407911be6d826e8ad";
const DEPOSITS_BLOCK = 22983301n;
const WITHDRAW_BLOCK = 22983305n;
const CKB = 100_000_000n;

test("the history the tests read is where they say", { skip: NO_NETWORK }, async () => {
  const rpc = jsonRpc(RPC_URL);
  assert.equal(BigInt((await rpc("get_transaction", [DEPOSITS_TX])).tx_status.block_number), DEPOSITS_BLOCK);
  assert.equal(BigInt((await rpc("get_transaction", [WITHDRAW_TX])).tx_status.block_number), WITHDRAW_BLOCK);
});

test("before the deposits the lock weighs nothing", { skip: NO_NETWORK }, async () => {
  const r = await daoWeightAt(RPC_URL, LOCK, DEPOSITS_BLOCK - 1n);
  assert.equal(r.weight, 0n);
  assert.equal(r.deposits.length + r.withdrawing.length, 0);
});

test("both deposits count from their block until the withdrawal", { skip: NO_NETWORK }, async (t) => {
  for (const at of [DEPOSITS_BLOCK, WITHDRAW_BLOCK - 1n]) {
    const r = await daoWeightAt(RPC_URL, LOCK, at);
    t.diagnostic(`block ${at}: ${r.weight / CKB} CKB in ${r.deposits.length} deposits`);
    assert.equal(r.weight, 500n * CKB);
    assert.deepEqual(r.deposits.map((d) => d.capacity).sort(), [200n * CKB, 300n * CKB].sort());
    assert.equal(r.withdrawing.length, 0);
  }
});

test("a deposit in phase 1 of a withdrawal stops counting at that block", { skip: NO_NETWORK }, async (t) => {
  const r = await daoWeightAt(RPC_URL, LOCK, WITHDRAW_BLOCK);
  t.diagnostic(`block ${WITHDRAW_BLOCK}: ${r.weight / CKB} CKB counted; ${r.withdrawing.length} withdrawing cell of ${r.withdrawing[0]?.capacity / CKB} CKB not counted`);
  assert.equal(r.weight, 300n * CKB);
  assert.equal(r.deposits.length, 1);
  // The precondition of the double count: the withdrawing cell is live and keeps the DAO type, so a
  // count by type alone would still give 500 CKB here.
  assert.equal(r.withdrawing.length, 1);
  assert.equal(r.withdrawing[0].capacity, 200n * CKB);
  assert.equal(r.withdrawing[0].outPoint.txHash, WITHDRAW_TX);
  assert.equal(r.weight + r.withdrawing[0].capacity, 500n * CKB);
});

test("a lock whose args are a prefix of the depositor's weighs nothing", { skip: NO_NETWORK }, async () => {
  const prefix = ccc.Script.from({ ...LOCK, args: LOCK.args.slice(0, -2) });
  const r = await daoWeightAt(RPC_URL, prefix, WITHDRAW_BLOCK);
  assert.equal(r.weight, 0n);
  // Control: the indexer's prefix search with the same script does return the deposit.
  const found = await jsonRpc(RPC_URL)("get_cells", [
    { script: JsonRpcTransformers.scriptFrom(prefix), script_type: "lock", script_search_mode: "prefix", filter: { script: { code_hash: NERVOS_DAO_CODE_HASH, hash_type: "type", args: "0x" } } },
    "asc",
    "0x64",
  ]);
  assert.ok(found.objects.some((c: any) => c.out_point.tx_hash === DEPOSITS_TX));
});

test("a snapshot past the tip is refused, not answered", { skip: NO_NETWORK }, async () => {
  const tip = BigInt((await jsonRpc(RPC_URL)("get_tip_header", [])).number);
  await assert.rejects(daoWeightAt(RPC_URL, LOCK, tip + 1000n), /past the tip/);
});

test("a history longer than the pages allowed is refused, not cut short", { skip: NO_NETWORK }, async () => {
  await assert.rejects(daoWeightAt(RPC_URL, LOCK, WITHDRAW_BLOCK, { maxPages: 0 }), /did not end within 0 pages/);
});
