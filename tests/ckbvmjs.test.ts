// ckbVmJs: the lock run by ckb-vm-js (CKB's verifier and CKB-VM in WebAssembly). Offline: the request
// it builds and how it reads a result. With CKB_VM_JS (an installed ckb-vm-js package directory): every
// saved proof, compared with ward-vm when WARD_VM or WARD_VM_WSL is set as well.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ccc } from "@ckb-ccc/core";
import { DEFAULT_MAX_CYCLES, NotLiveError, ckbVmJs, ckbVmJsConsensus, ckbVmJsRequest, mockTransaction, parseCkbVmJsRun, proofInput, resolveCellDeps, verify, type CkbVmJsVerifier, type MockTransaction } from "../src/index.ts";
import { NO_NETWORK, expectFor, flipWitnessByte, rpcFor, vectors, wardVmFor } from "./helpers.ts";

// ckb-vm-js 0.2.0's verifier as its index.d.ts declares it, the part ckbVmJs calls. The caller passes
// `await createVerifier()`, so it must fit CkbVmJsVerifier; `npm run typecheck` fails if it does not.
type Hex = `0x${string}`;
interface VmJsVerifier {
  verifyScriptGroup(
    request: { transaction: unknown; context: unknown; max_cycles: Hex },
    group: { group_type: "lock" | "type"; script_hash: Hex },
  ): Promise<{ ok: boolean; cycles?: Hex; error?: { code: string; message: string }; [key: string]: unknown }>;
}
export const fitsCkbVmJs = (v: VmJsVerifier): CkbVmJsVerifier => v;

// get_consensus from the testnet node, 2026-11-16 (the fields read here).
const TESTNET_CONSENSUS = {
  tx_version: "0x0",
  max_block_bytes: "0x91c08",
  max_block_cycles: "0xd09dc300",
  cellbase_maturity: "0x10000000004",
  median_time_block_count: "0x25",
  tx_proposal_window: { closest: "0x2", farthest: "0xa" },
  dao_type_hash: "0x82d76d1b75fe2fd9a27dfbaa65a039221a380d76c926f378d3f81cf3e7e13f2e",
  hardfork_features: [
    { epoch_number: "0xc29", rfc: "0028" },
    { epoch_number: "0x0", rfc: "0029" },
    { epoch_number: "0xc29", rfc: "0032" },
    { epoch_number: "0x25da", rfc: "0048" },
    { epoch_number: "0x25da", rfc: "0049" },
  ],
  softforks: { light_client: { active: true, epoch: "0x164f", status: "buried" } },
};

test("consensus from get_consensus: hardfork epochs, the light client softfork as RFC 0044", () => {
  const c = ckbVmJsConsensus(TESTNET_CONSENSUS) as any;
  assert.deepEqual(c.hardforks, { rfc0028_epoch: "0xc29", rfc0032_epoch: "0xc29", rfc0049_epoch: "0x25da", rfc0044_epoch: "0x164f" });
  assert.equal(c.starting_block_limiting_dao_withdrawing_lock, "0x989680");
  assert.equal(c.dao_type_hash, TESTNET_CONSENSUS.dao_type_hash);
  // A node that does not report a fork is refused, not run under a guessed VM version.
  assert.throws(() => ckbVmJsConsensus({ ...TESTNET_CONSENSUS, hardfork_features: [] }), /no hardfork feature 0028/);
  assert.throws(() => ckbVmJsConsensus({ ...TESTNET_CONSENSUS, softforks: {} }), /light client/);
});

const MOCK: MockTransaction = {
  mock_info: {
    inputs: [{ input: { since: "0x0", previous_output: { tx_hash: `0x${"11".repeat(32)}`, index: "0xffffffff" } }, output: { capacity: "0xffffffffffffffff", lock: { code_hash: `0x${"22".repeat(32)}`, hash_type: "type", args: "0x" }, type: null }, data: "0x", header: null }],
    cell_deps: [{ cell_dep: { out_point: { tx_hash: `0x${"33".repeat(32)}`, index: "0x0" }, dep_type: "code" }, output: { capacity: "0x1", lock: { code_hash: `0x${"44".repeat(32)}`, hash_type: "data", args: "0x" }, type: undefined as unknown }, data: "0x00", header: null }],
    header_deps: [{ hash: `0x${"55".repeat(32)}`, number: "0x1" }],
    extensions: [],
  },
  tx: { version: "0x0", hash: `0x${"66".repeat(32)}` },
};

test("request: every cell with an unknown origin, no hash fields, header deps with no extension", () => {
  const r = ckbVmJsRequest(MOCK, { c: 1 }, { number: "0x9", hash: `0x${"77".repeat(32)}` }, DEFAULT_MAX_CYCLES) as any;
  assert.deepEqual(r.transaction, { version: "0x0" });
  assert.deepEqual(r.context.tip_header, { number: "0x9" });
  assert.equal(r.max_cycles, "0x42c1d80");
  assert.deepEqual(r.context.consensus, { c: 1 });
  assert.deepEqual(
    r.context.cells.map((c: any) => [c.out_point.index, c.output.type, c.transaction_info]),
    [["0xffffffff", null, null], ["0x0", null, null]],
  );
  assert.equal(r.context.cells[0].output.capacity, "0xffffffffffffffff");
  assert.deepEqual(r.context.headers, [{ number: "0x1" }]);
  assert.deepEqual(r.context.extensions, [{ block_hash: `0x${"55".repeat(32)}`, data: null }]);
});

test("result: an exit code only when the lock itself exited", () => {
  assert.deepEqual(parseCkbVmJsRun({ ok: true, cycles: "0x191b69" }), { code: 0, cycles: 1645417n, output: "" });
  const page = "https://nervosnetwork.github.io/ckb-script-error-codes/by-type-hash/9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8.html#-31";
  assert.equal(parseCkbVmJsRun({ ok: false, error: { code: "Script", message: `ValidationFailure: see error code -31 on page ${page}` } }).code, -31);
  assert.equal(parseCkbVmJsRun({ ok: false, error: { code: "Script", message: "ValidationFailure: see error code 26 on page x" } }).code, 26);
  // No exit: out of cycles, a malformed request, or the same words outside a script error.
  assert.equal(parseCkbVmJsRun({ ok: false, error: { code: "Script", message: "ExceededMaximumCycles: expect cycles <= 16" } }).code, null);
  assert.equal(parseCkbVmJsRun({ ok: false, error: { code: "InvalidRequest", message: "unknown field `hash`" } }).code, null);
  assert.equal(parseCkbVmJsRun({ ok: false, error: { code: "InvalidRequest", message: "ValidationFailure: see error code 0 on page x" } }).code, null);
  assert.equal(parseCkbVmJsRun({ ok: true }).code, null);
});

// ---------- with ckb-vm-js ----------

const PKG = process.env.CKB_VM_JS;
const NO_VM_JS = PKG ? false : "set CKB_VM_JS to an installed ckb-vm-js package directory";
let made: Promise<CkbVmJsVerifier> | undefined;
async function vmJs(): Promise<CkbVmJsVerifier> {
  made ??= import(pathToFileURL(join(PKG!, "js", "index.js")).href).then((m) => m.createVerifier({ wasm: readFileSync(join(PKG!, "pkg", "ckb_wasm_verifier_bg.wasm")) }));
  return made;
}

for (const v of vectors) {
  test(`${v.name}: ckb-vm-js runs the lock as ward-vm does`, { skip: NO_NETWORK || NO_VM_JS }, async (t) => {
    const tx = ccc.Transaction.from(v.tx);
    let deps;
    try {
      deps = await resolveCellDeps(rpcFor(v), tx.cellDeps);
    } catch (e) {
      if (e instanceof NotLiveError) return t.skip(e.message);
      throw e;
    }
    const runLock = ckbVmJs({ verifier: await vmJs(), rpcUrl: rpcFor(v) });
    const vm = wardVmFor(v);
    for (const [label, signed, want] of [
      ["accepted", tx, 0],
      ["bit flipped", flipWitnessByte(v.tx, v.signatureByte), v.signatureFlipExit],
    ] as const) {
      const mock = mockTransaction(signed, proofInput(v.lock), deps);
      const run = await runLock(mock);
      const other = vm ? await vm(mock) : undefined;
      t.diagnostic(`${label}: ckb-vm-js ${run.code} (${run.cycles})${other ? `, ward-vm ${other.code} (${other.cycles})` : ""}`);
      assert.equal(run.code, want, run.output);
      if (other) {
        assert.equal(run.code, other.code);
        if (want === 0) assert.equal(run.cycles, other.cycles);
      }
    }
    const r = await verify({ lock: v.lock, message: v.message, tx: v.tx }, { rpcUrl: rpcFor(v), runLock, expect: expectFor(v.message) });
    assert.equal(r.ok, true, r.ok ? "" : r.reason);
  });
}

test("ckb-vm-js refuses a header whose hash does not match, so the runner drops it (control)", { skip: NO_NETWORK || NO_VM_JS }, async () => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const tx = ccc.Transaction.from(v.tx);
  const mock = mockTransaction(tx, proofInput(v.lock), await resolveCellDeps(rpcFor(v), tx.cellDeps));
  const call = async (method: string) => (await (await fetch(rpcFor(v), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params: [] }) })).json()).result;
  const [c, tip] = [ckbVmJsConsensus(await call("get_consensus")), await call("get_tip_header")];
  const request = ckbVmJsRequest(mock, c, tip, DEFAULT_MAX_CYCLES) as any;
  const group = { group_type: "lock" as const, script_hash: ccc.Script.from(v.lock).hash() };
  const verifier = await vmJs();
  assert.equal((await verifier.verifyScriptGroup(request, group)).ok, true);
  const withHash = (hash: string) => ({ ...request, context: { ...request.context, tip_header: { ...tip, hash } } });
  assert.equal((await verifier.verifyScriptGroup(withHash(tip.hash), group)).ok, true);
  const wrong = tip.hash.slice(0, -2) + (tip.hash.endsWith("00") ? "01" : "00");
  const raw = await verifier.verifyScriptGroup(withHash(wrong), group);
  assert.equal(raw.ok, false);
  assert.match(raw.error!.message, /header hash does not match/);
});
