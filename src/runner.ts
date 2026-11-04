import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A resolved cell in the ckb-debugger mock format (JSON RPC field names). */
export interface MockCell {
  output: { capacity: string; lock: unknown; type: unknown };
  data: string;
  header: null;
}

/** The transaction plus every cell it touches, as ckb-debugger reads it with --tx-file. */
export interface MockTransaction {
  mock_info: {
    inputs: (MockCell & { input: { since: string; previous_output: { tx_hash: string; index: string } } })[];
    cell_deps: (MockCell & { cell_dep: { out_point: { tx_hash: string; index: string }; dep_type: string } })[];
    header_deps: [];
    extensions: [];
  };
  tx: unknown;
}

/** Result of running input 0's lock. code 0 means the lock accepted. code null means it did not run to an exit. */
export interface LockRun {
  code: number | null;
  cycles?: bigint;
  output: string;
}

/** Runs the lock script group of input 0 of a mock transaction. */
export type RunLock = (mock: MockTransaction) => Promise<LockRun>;

export interface CkbDebuggerOptions {
  /** The ckb-debugger executable. Inside WSL, give the full path (no login shell runs). */
  command?: string;
  /** Run through `wsl -d <distro>` (Windows). Unset: run the command directly. */
  wsl?: { distro: string; user?: string };
  /** Cycle limit for one run. Default 70,000,000 (ten times the largest lock measured here). */
  maxCycles?: number;
  /** Where the mock file is written. Default: the OS temp directory. */
  tmpDir?: string;
  timeoutMs?: number;
}

export const DEFAULT_MAX_CYCLES = 70_000_000;
/** Most stdout kept from one run. A lock can print through the debug syscall; only the tail matters. */
const MAX_KEPT_OUTPUT = 1 << 20;

/** C:\a\b -> /mnt/c/a/b */
export function toWslPath(path: string): string {
  return path.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

interface Exited {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, timeout: timeoutMs });
    let stdout = "";
    let stderr = "";
    const keep = (s: string) => (s.length > MAX_KEPT_OUTPUT ? s.slice(-MAX_KEPT_OUTPUT) : s);
    child.stdout.on("data", (b: Buffer) => (stdout = keep(stdout + b.toString("utf8"))));
    child.stderr.on("data", (b: Buffer) => (stderr = keep(stderr + b.toString("utf8"))));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

const RESULT = /^Run result: (-?\d+)$/;
const CYCLES = /^All cycles: ([\d,]+)(?:\([^)]*\))?$/;

/**
 * Reads the outcome of one ckb-debugger run (tested with 1.1.1).
 *
 * The debugger ends stdout with its own two lines, "Run result: <exit code>" and
 * "All cycles: <n>", and exits 0 only when the script exited 0 (254 otherwise). A lock can print
 * through the debug syscall, and its text reaches stdout as "Script log: ..." with any line feeds
 * kept, so it can print lines that look like the debugger's. Only the last two lines of stdout
 * count, and an exit 0 counts only when the debugger process also exited 0.
 */
export function parseDebuggerRun(r: Exited): LockRun {
  const lines = r.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const result = lines.at(-2)?.match(RESULT);
  const cycles = lines.at(-1)?.match(CYCLES);
  const output = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join("\n");
  const parsed = result && cycles ? Number(result[1]) : null;
  const cyclesValue = cycles ? BigInt(cycles[1].replace(/,/g, "")) : undefined;
  // Exit 0 needs both the debugger's last lines and its process status. A non-zero lock exit is
  // reported as such only when the debugger also failed, so the two never disagree.
  let code: number | null = null;
  if (parsed === 0 && r.status === 0) code = 0;
  else if (parsed !== null && parsed !== 0 && r.status !== 0 && r.status !== null) code = parsed;
  return { code, cycles: code === null ? undefined : cyclesValue, output };
}

/**
 * A RunLock backed by ckb-debugger (tested with 1.1.1, script version 2). Good for development and
 * tests. A production verifier should embed ckb-script with the target chain's consensus instead.
 */
export function ckbDebugger(options: CkbDebuggerOptions = {}): RunLock {
  const command = options.command ?? "ckb-debugger";
  const maxCycles = options.maxCycles ?? DEFAULT_MAX_CYCLES;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return async (mock) => {
    const dir = await mkdtemp(join(options.tmpDir ?? tmpdir(), "ckb-ward-"));
    try {
      const file = join(dir, "mock.json");
      await writeFile(file, JSON.stringify(mock));
      const args = ["--tx-file", options.wsl ? toWslPath(file) : file, "--script", "input.0.lock", "--max-cycles", String(maxCycles)];
      const r = options.wsl
        ? await run("wsl", ["-d", options.wsl.distro, "-u", options.wsl.user ?? "root", "--exec", command, ...args], timeoutMs)
        : await run(command, args, timeoutMs);
      return parseDebuggerRun(r);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
