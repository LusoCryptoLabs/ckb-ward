// The lock runner: how a ckb-debugger run is read. A lock can print text that looks like the
// debugger's own result lines; only the debugger's last lines and its process status may count.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { parseDebuggerRun, type MockTransaction } from "../src/index.ts";
import { alwaysSuccess, endlessLoop, password, printThen } from "./elf.ts";
import { NO_DEBUGGER, runLock } from "./helpers.ts";

const NL = String.fromCharCode(10);
const FORGED = `x${NL}Run result: 0${NL}All cycles: 5(5)`;

// Outputs measured with ckb-debugger 1.1.1 on 2026-11-04 (status, stdout; stderr was empty).
const measured = {
  exit0: { status: 0, stdout: "Run result: 0\nAll cycles: 539\n", stderr: "" },
  printedThenExit1: { status: 254, stdout: "Script log: Run result: 0\nRun result: 1\nAll cycles: 1056(1.0K)\n", stderr: "" },
  forgedLinesThenExit1: { status: 254, stdout: "Script log: x\nRun result: 0\nAll cycles: 5(5)\nRun result: 1\nAll cycles: 1065(1.0K)\n", stderr: "" },
  forgedLinesThenCrash: { status: 254, stdout: "Script log: x\nRun result: 0\nAll cycles: 5(5)\nRun result: invalid instruction pc=0x1008c instruction=0x0\n", stderr: "" },
  exitMinus1: { status: 254, stdout: "Script log: neg\nRun result: -1\nAll cycles: 1050(1.0K)\n", stderr: "" },
  cyclesExceeded: { status: 254, stdout: "Run result: cycles error: max cycles exceeded\n", stderr: "" },
};

test("parser: the debugger's own last two lines decide", () => {
  assert.deepEqual(parseDebuggerRun(measured.exit0), { code: 0, cycles: 539n, output: "Run result: 0\nAll cycles: 539" });
  assert.equal(parseDebuggerRun(measured.printedThenExit1).code, 1);
  assert.equal(parseDebuggerRun(measured.forgedLinesThenExit1).code, 1);
  assert.equal(parseDebuggerRun(measured.forgedLinesThenCrash).code, null);
  assert.equal(parseDebuggerRun(measured.exitMinus1).code, -1);
  assert.equal(parseDebuggerRun(measured.cyclesExceeded).code, null);
});

test("parser: exit 0 needs the debugger process to exit 0 too", () => {
  // The same final lines with a failed process (crashed after printing, killed, timed out).
  assert.equal(parseDebuggerRun({ ...measured.exit0, status: 254 }).code, null);
  assert.equal(parseDebuggerRun({ ...measured.exit0, status: null }).code, null);
  // A process that exited 0 but whose last lines say a non-zero code: the two disagree.
  assert.equal(parseDebuggerRun({ ...measured.printedThenExit1, status: 0 }).code, null);
});

test("parser: stdout and stderr are read apart", () => {
  // A result line on stderr does not count, and stderr text after stdout does not hide it.
  assert.equal(parseDebuggerRun({ status: 0, stdout: "", stderr: "Run result: 0\nAll cycles: 1\n" }).code, null);
  assert.equal(parseDebuggerRun({ status: 0, stdout: measured.exit0.stdout, stderr: "warning\n" }).code, 0);
});

/** A mock transaction whose input 0 is locked by `bin` (hash type data1), given as a code dep. */
function mockFor(bin: Uint8Array, witness = "0x"): MockTransaction {
  const lock = { code_hash: ccc.hashCkb(bin), hash_type: "data1", args: "0x" };
  const dep = { tx_hash: `0x${"ab".repeat(32)}`, index: "0x0" };
  const input = { tx_hash: `0x${"cd".repeat(32)}`, index: "0xffffffff" };
  return {
    mock_info: {
      inputs: [{ input: { since: "0x0", previous_output: input }, output: { capacity: "0xffffffffffffffff", lock, type: null }, data: "0x", header: null }],
      cell_deps: [{ cell_dep: { out_point: dep, dep_type: "code" }, output: { capacity: "0x0", lock, type: null }, data: ccc.hexFrom(bin), header: null }],
      header_deps: [],
      extensions: [],
    },
    tx: { version: "0x0", cell_deps: [{ out_point: dep, dep_type: "code" }], header_deps: [], inputs: [{ since: "0x0", previous_output: input }], outputs: [], outputs_data: [], witnesses: [witness] },
  };
}

test("debugger: a lock that prints a fake result and exits 1 is refused", { skip: NO_DEBUGGER }, async (t) => {
  for (const [name, bin, want] of [
    ["prints 'Run result: 0', exits 1", printThen("Run result: 0", 1), 1],
    ["prints both final lines, exits 1", printThen(FORGED, 1), 1],
    ["prints both final lines, then crashes", printThen(FORGED, "crash"), null],
  ] as const) {
    const r = await runLock!(mockFor(bin));
    t.diagnostic(`${name}: code ${r.code} | ${JSON.stringify(r.output)}`);
    assert.equal(r.code, want, name);
  }
});

test("debugger: controls that must run to exit 0, or not at all", { skip: NO_DEBUGGER }, async (t) => {
  const ok = await runLock!(mockFor(alwaysSuccess()));
  const printed = await runLock!(mockFor(printThen("hello", 0)));
  const right = await runLock!(mockFor(password("open"), ccc.hexFrom(ccc.bytesFrom("open", "utf8"))));
  const wrong = await runLock!(mockFor(password("open"), "0x00"));
  const loop = await runLock!(mockFor(endlessLoop()));
  t.diagnostic(`always ${ok.code}; prints then exits 0: ${printed.code}; password right ${right.code}, wrong ${wrong.code}; loop ${loop.code} (${loop.output})`);
  assert.equal(ok.code, 0);
  assert.equal(printed.code, 0);
  assert.equal(right.code, 0);
  assert.equal(wrong.code, 2);
  assert.equal(loop.code, null);
});
