// What a lock runner takes and returns. No Node built-ins here: the browser entry imports it too.

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
    /** Resolved header views (JSON RPC format), for a lock that reads a header dep. Empty for most proofs. */
    header_deps: unknown[];
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

/** Cycle limit for one run. 70,000,000 is ten times the largest lock measured here. */
export const DEFAULT_MAX_CYCLES = 70_000_000;
