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

/** Result of running input 0's lock. code 0 means the lock accepted. code null means it did not run. */
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

/** C:\a\b -> /mnt/c/a/b */
export function toWslPath(path: string): string {
  return path.replace(/^([A-Za-z]):[\\/]/, (_, d: string) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => (out += b.toString("utf8")));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, out }));
  });
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
    const dir = await mkdtemp(join(options.tmpDir ?? tmpdir(), "ckb-lock-proof-"));
    try {
      const file = join(dir, "mock.json");
      await writeFile(file, JSON.stringify(mock));
      const args = ["--tx-file", options.wsl ? toWslPath(file) : file, "--script", "input.0.lock", "--max-cycles", String(maxCycles)];
      const r = options.wsl
        ? await run("wsl", ["-d", options.wsl.distro, "-u", options.wsl.user ?? "root", "--exec", command, ...args], timeoutMs)
        : await run(command, args, timeoutMs);
      const code = r.out.match(/Run result: (-?\d+)/);
      const cycles = r.out.match(/All cycles: ([\d,]+)/);
      return {
        code: code ? Number(code[1]) : null,
        cycles: cycles ? BigInt(cycles[1].replace(/,/g, "")) : undefined,
        output: r.out.trim(),
      };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}
