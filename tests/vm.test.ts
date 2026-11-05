// ward-vm: the lock run by the node's own ckb-script under the chain's consensus. Its result line,
// the locks assembled in tests/elf.ts against it, a syscall only ckb-debugger has, and every saved
// proof run by both runners, which must agree on the exit code and the cycles.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { message, mockTransaction, parseWardVmRun, proofInput, proofTemplate, resolveCellDeps, verify, type RunLock } from "../src/index.ts";
import { alwaysSuccess, debuggerSyscall, password } from "./elf.ts";
import { NO_BOTH, NO_NETWORK, RPC_URL, debuggerRunLock, expectFor, flipWitnessByte, vectors, wardVmRunLock } from "./helpers.ts";
import { TESTNET_GENESIS, startStub, type Stub } from "./stub.ts";

const NO_WARD_VM = wardVmRunLock ? false : "set WARD_VM or WARD_VM_WSL to run ward-vm";
const owner = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" });

test("ward-vm result: the lock's exit code and cycles", () => {
  assert.deepEqual(parseWardVmRun({ status: 0, stdout: '{"code":0,"cycles":"1645417"}\n', stderr: "" }), { code: 0, cycles: 1645417n, output: '{"code":0,"cycles":"1645417"}' });
  const refused = parseWardVmRun({ status: 0, stdout: '{"code":-31,"cycles":"1700000"}\n', stderr: "Script log: bad signature" });
  assert.equal(refused.code, -31);
  assert.equal(refused.cycles, 1700000n);
});

test("ward-vm result: no exit is code null, whatever else was printed", () => {
  assert.equal(parseWardVmRun({ status: 0, stdout: '{"code":null,"error":"ExceededMaximumCycles"}\n', stderr: "" }).code, null);
  assert.equal(parseWardVmRun({ status: 2, stdout: "", stderr: "ward-vm: --epoch is required" }).code, null);
  // The lock's own output goes to stderr: a result line printed there does not count.
  assert.equal(parseWardVmRun({ status: 0, stdout: "", stderr: 'Script log: {"code":0,"cycles":"1"}' }).code, null);
  assert.equal(parseWardVmRun({ status: 0, stdout: "not json\n", stderr: "" }).code, null);
});

async function rawRun(stub: Stub, runLock: RunLock, bin: Uint8Array, witness: ccc.HexLike) {
  const dep = ccc.CellDep.from({ outPoint: stub.fabricate({ capacity: BigInt(bin.length + 100) * 100000000n, lock: owner, data: bin }, "vm"), depType: "code" });
  const lock = ccc.Script.from({ codeHash: ccc.hashCkb(bin), hashType: "data1", args: "0x" });
  const text = message({ domain: "dao.example", account: "vm", lock, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: "n-vm" });
  const tx = proofTemplate(lock, text);
  tx.cellDeps = [dep];
  tx.witnesses = [ccc.hexFrom(witness)];
  return { run: await runLock(mockTransaction(tx, proofInput(lock), await resolveCellDeps(stub.url, tx.cellDeps))), proof: { lock, message: text, tx } };
}

test("ward-vm runs assembled locks: always-success exits 0, a password lock only with its password", { skip: NO_WARD_VM }, async (t) => {
  const stub = await startStub();
  try {
    const open = await rawRun(stub, wardVmRunLock!, alwaysSuccess(), "0x");
    const right = await rawRun(stub, wardVmRunLock!, password("open"), ccc.hexFrom(ccc.bytesFrom("open", "utf8")));
    const wrong = await rawRun(stub, wardVmRunLock!, password("open"), "0x");
    t.diagnostic(`always-success ${open.run.code}; password right ${right.run.code}, empty ${wrong.run.code}`);
    assert.equal(open.run.code, 0);
    assert.equal(right.run.code, 0);
    assert.notEqual(wrong.run.code, 0);
  } finally {
    await stub.close();
  }
});

test("verify() with ward-vm still refuses an always-success lock (probe a)", { skip: NO_WARD_VM }, async (t) => {
  const stub = await startStub();
  try {
    const { proof } = await rawRun(stub, wardVmRunLock!, alwaysSuccess(), "0x");
    const r = await verify(proof, { rpcUrl: stub.url, runLock: wardVmRunLock!, expect: expectFor(proof.message, { now: new Date() }) });
    t.diagnostic(r.ok ? "ACCEPTED" : `REFUSED, ${r.reason}`);
    assert.equal(!r.ok && r.reason, "no exclusive control: the lock opens with an empty witness");
  } finally {
    await stub.close();
  }
});

test("a syscall only ckb-debugger has: the debugger exits 0, ward-vm stops as a node would", { skip: NO_WARD_VM }, async (t) => {
  const stub = await startStub();
  try {
    const vm = await rawRun(stub, wardVmRunLock!, debuggerSyscall(), "0x");
    t.diagnostic(`ward-vm: code ${vm.run.code}; ${vm.run.output.split("\n").at(-1)}`);
    assert.equal(vm.run.code, null);
    assert.match(vm.run.output, /invalid syscall 9001/);
    // Control: the same program without the syscall exits 0 under ward-vm.
    const plain = await rawRun(stub, wardVmRunLock!, alwaysSuccess(), "0x");
    assert.equal(plain.run.code, 0);
    if (debuggerRunLock) {
      const dbg = await rawRun(stub, debuggerRunLock, debuggerSyscall(), "0x");
      t.diagnostic(`ckb-debugger: code ${dbg.run.code}`);
      assert.equal(dbg.run.code, 0);
    }
  } finally {
    await stub.close();
  }
});

for (const v of vectors) {
  test(`${v.name}: ckb-debugger and ward-vm agree, accepted and with one bit flipped`, { skip: NO_NETWORK || NO_BOTH }, async (t) => {
    const lock = ccc.Script.from(v.lock);
    const deps = await resolveCellDeps(RPC_URL, ccc.Transaction.from(v.tx).cellDeps);
    for (const [label, tx] of [
      ["accepted", ccc.Transaction.from(v.tx)],
      ["bit flipped", flipWitnessByte(v.tx, v.signatureByte)],
    ] as const) {
      const mock = mockTransaction(tx, proofInput(lock), deps);
      const [dbg, vm] = [await debuggerRunLock!(mock), await wardVmRunLock!(mock)];
      t.diagnostic(`${label}: ckb-debugger ${dbg.code} (${dbg.cycles}), ward-vm ${vm.code} (${vm.cycles})`);
      assert.equal(vm.code, dbg.code);
      assert.equal(vm.cycles, dbg.cycles);
    }
    assert.equal((await verify({ lock: v.lock, message: v.message, tx: v.tx }, { rpcUrl: RPC_URL, runLock: wardVmRunLock!, expect: expectFor(v.message) })).ok, true);
  });
}
