// Reading a proof transaction as it arrives. verify() takes a JSON transaction; the CCC parser fills
// in and rewrites what it is given (it raises an output capacity to the minimum, accepts hex with
// leading zeros or without the prefix, and throws on a transaction with no input). These checks make
// the TypeScript verifier read the same bytes the Rust verifier reads: a transaction that is not
// written in the canonical JSON form is refused as malformed, and a value the parser changed is
// refused, so what the lock runs is exactly what the prover sent.
import { ccc } from "@ckb-ccc/core";

const U32 = 0xffffffffn;
const U64 = 0xffffffffffffffffn;
const HEX_NUM = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const HEX_BYTES = /^0x(?:[0-9a-fA-F]{2})*$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A number as the JSON form writes it: 0x hex with no leading zeros, or a plain non-negative integer. */
function numberOf(v: unknown, max: bigint, what: string): bigint | string {
  let n: bigint;
  if (typeof v === "bigint") n = v;
  else if (typeof v === "number") {
    if (!Number.isSafeInteger(v) || v < 0) return `${what} is not a non-negative integer`;
    n = BigInt(v);
  } else if (typeof v === "string") {
    if (!HEX_NUM.test(v)) return `${what} is not canonical 0x hex`;
    n = BigInt(v);
  } else return `${what} is not a number`;
  if (n < 0n || n > max) return `${what} is out of range`;
  return n;
}

/** A key written in both spellings (`outputsData` and `outputs_data`) anywhere inside the value: the two verifiers would read different ones. */
function twinKey(v: unknown): string | undefined {
  if (Array.isArray(v)) {
    for (const x of v) {
      const t = twinKey(x);
      if (t) return t;
    }
    return undefined;
  }
  if (!isObject(v)) return undefined;
  for (const k of Object.keys(v)) {
    const camel = k.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
    if (camel !== k && camel in v) return `the key ${camel} is written twice (camelCase and snake_case)`;
    const t = twinKey(v[k]);
    if (t) return t;
  }
  return undefined;
}

const bytesOk = (v: unknown, what: string, len?: number): string | undefined => {
  if (typeof v !== "string" || !HEX_BYTES.test(v)) return `${what} is not 0x hex bytes`;
  if (len !== undefined && (v.length - 2) / 2 !== len) return `${what} is not ${len} bytes`;
  return undefined;
};

function scriptProblem(s: unknown, what: string): string | undefined {
  if (!isObject(s)) return `${what} is not an object`;
  return bytesOk(s.codeHash, `${what}.codeHash`, 32) ?? (typeof s.hashType === "string" ? undefined : `${what}.hashType is not a string`) ?? bytesOk(s.args, `${what}.args`);
}

/** The reason a lock given as JSON is not in the canonical form, or undefined. Class instances are not checked. */
export function lockProblem(lock: unknown): string | undefined {
  if (lock instanceof ccc.Script) return undefined;
  return twinKey(lock) ?? scriptProblem(lock, "lock");
}

/**
 * The reason a transaction given as JSON is not in the canonical form, or undefined. A
 * `ccc.Transaction` instance is already normalised by its constructor and is not checked.
 */
export function wireProblem(raw: unknown): string | undefined {
  if (raw instanceof ccc.Transaction) return undefined;
  if (!isObject(raw)) return "transaction is not an object";
  const twin = twinKey(raw);
  if (twin) return twin;
  const list = (k: string): unknown[] | string => (Array.isArray(raw[k]) ? (raw[k] as unknown[]) : `${k} is not a list`);
  const version = numberOf(raw.version ?? 0, U32, "version");
  if (typeof version === "string") return version;
  const [deps, headers, inputs, outputs, data, witnesses] = ["cellDeps", "headerDeps", "inputs", "outputs", "outputsData", "witnesses"].map(list);
  for (const l of [deps, headers, inputs, outputs, data, witnesses]) if (typeof l === "string") return l;
  for (const [i, d] of (deps as unknown[]).entries()) {
    if (!isObject(d) || !isObject(d.outPoint)) return `cellDeps[${i}] is not a cell dep`;
    const p = bytesOk(d.outPoint.txHash, `cellDeps[${i}].outPoint.txHash`, 32);
    if (p) return p;
    const idx = numberOf(d.outPoint.index, U32, `cellDeps[${i}].outPoint.index`);
    if (typeof idx === "string") return idx;
    if (d.depType !== "code" && d.depType !== "depGroup") return `cellDeps[${i}].depType is not code or depGroup`;
  }
  for (const [i, h] of (headers as unknown[]).entries()) {
    const p = bytesOk(h, `headerDeps[${i}]`, 32);
    if (p) return p;
  }
  for (const [i, inp] of (inputs as unknown[]).entries()) {
    if (!isObject(inp) || !isObject(inp.previousOutput)) return `inputs[${i}] is not an input`;
    const p = bytesOk(inp.previousOutput.txHash, `inputs[${i}].previousOutput.txHash`, 32);
    if (p) return p;
    const idx = numberOf(inp.previousOutput.index, U32, `inputs[${i}].previousOutput.index`);
    if (typeof idx === "string") return idx;
    const since = numberOf(inp.since ?? 0, U64, `inputs[${i}].since`);
    if (typeof since === "string") return since;
  }
  for (const [i, o] of (outputs as unknown[]).entries()) {
    if (!isObject(o)) return `outputs[${i}] is not an output`;
    const cap = numberOf(o.capacity, U64, `outputs[${i}].capacity`);
    if (typeof cap === "string") return cap;
    const lock = scriptProblem(o.lock, `outputs[${i}].lock`);
    if (lock) return lock;
    if (o.type !== undefined && o.type !== null) {
      const t = scriptProblem(o.type, `outputs[${i}].type`);
      if (t) return t;
    }
  }
  for (const [i, d] of (data as unknown[]).entries()) {
    const p = bytesOk(d, `outputsData[${i}]`);
    if (p) return p;
  }
  for (const [i, w] of (witnesses as unknown[]).entries()) {
    const p = bytesOk(w, `witnesses[${i}]`);
    if (p) return p;
  }
  return undefined;
}

const num = (v: unknown): bigint => (typeof v === "bigint" ? v : BigInt(v as number | string));

/**
 * True when the parser changed a number the prover sent: an output capacity raised to the minimum,
 * or a since, version or index that came out different. The caller refuses such a transaction: what
 * was parsed is not what was sent. Call only after wireProblem() returned undefined.
 */
export function rewritten(raw: unknown, tx: ccc.Transaction): boolean {
  if (raw instanceof ccc.Transaction) return false;
  const r = raw as { version?: unknown; inputs: { since?: unknown; previousOutput: { index: unknown } }[]; outputs: { capacity: unknown }[] };
  if (num(r.version ?? 0) !== tx.version) return true;
  if (r.inputs.length !== tx.inputs.length || r.outputs.length !== tx.outputs.length) return true;
  return (
    r.inputs.some((inp, i) => num(inp.since ?? 0) !== tx.inputs[i].since || num(inp.previousOutput.index) !== tx.inputs[i].previousOutput.index) ||
    r.outputs.some((o, i) => num(o.capacity) !== tx.outputs[i].capacity)
  );
}
