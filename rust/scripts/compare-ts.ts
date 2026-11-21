// Runs the same proofs through the TypeScript verify() and through the Rust crate, against the live
// chain, and compares the verdicts: accepted or refused, the refusal text, and the cycles.
//
// From the repository root, on Windows with ward-vm and cargo in the WSL distro ChiralSP1:
//   node rust/scripts/compare-ts.ts
// The cases: every vector, its controls, and a set of changes to each (a flipped signature bit,
// another message, an expired or future message, another domain, the output, the since, the deps,
// the witnesses, the lock).
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ccc } from "@ckb-ccc/core";
import { message, parseMessage, proofTemplate, tipEpoch, verify, wardVm } from "../../src/index.ts";
import { expectFor, flipWitnessByte, otherMessage, vectors } from "../../tests/helpers.ts";

const DISTRO = process.env.WSL_DISTRO ?? "ChiralSP1";
const WARD_VM = process.env.WARD_VM_PATH ?? "/root/ward-vm-target/release/ward-vm";
const RPC = { testnet: "https://testnet.ckb.dev/rpc", mainnet: "https://mainnet.ckb.dev/rpc" } as const;

type Net = keyof typeof RPC;
interface Case {
  name: string;
  net: Net;
  lock: ccc.ScriptLike;
  message: string;
  tx: ccc.Transaction;
  expect: ReturnType<typeof expectFor>;
}

const runners = Object.fromEntries(
  (["testnet", "mainnet"] as Net[]).map((n) => [n, wardVm({ command: WARD_VM, wsl: { distro: DISTRO, user: "root" }, chain: n, epoch: () => tipEpoch(RPC[n]) })]),
) as Record<Net, ReturnType<typeof wardVm>>;

const cases: Case[] = [];
for (const v of vectors) {
  const net: Net = v.network === "mainnet" ? "mainnet" : "testnet";
  const tx = ccc.Transaction.from(v.tx);
  const base = { net, lock: v.lock, message: v.message, expect: expectFor(v.message) };
  const add = (what: string, c: Partial<Case>) => cases.push({ name: `${v.file} ${what}`, ...base, tx, ...c } as Case);
  const edit = (f: (t: ccc.Transaction) => void) => {
    const t = tx.clone();
    f(t);
    return t;
  };
  add("as signed", {});
  add("signature bit flipped", { tx: flipWitnessByte(v.tx, v.signatureByte) });
  add("another message", { message: otherMessage(v.message), expect: expectFor(otherMessage(v.message)) });
  add("expired", { expect: { ...base.expect, now: new Date(base.expect.now!.getTime() + 600_000) } });
  add("issued in the future", { expect: { ...base.expect, now: new Date(base.expect.now!.getTime() - 122_000) } });
  add("another domain expected", { expect: { ...base.expect, domain: "other.example" } });
  add("two witnesses", { tx: edit((t) => (t.witnesses = [t.witnesses[0], t.witnesses[0]])) });
  add("empty witness", { tx: edit((t) => (t.witnesses = ["0x"])) });
  add("output capacity plus one", { tx: edit((t) => (t.outputs[0].capacity += 1n)) });
  add("since 5", { tx: edit((t) => (t.inputs[0].since = 5n)) });
  add("a dep listed twice", { tx: edit((t) => t.cellDeps.push(t.cellDeps[0].clone())) });
  add("no cell deps", { tx: edit((t) => (t.cellDeps = [])) });
  add("an unknown header dep", { tx: edit((t) => (t.headerDeps = [`0x${"5a".repeat(32)}`])) });
  add("a dep that is not live", { tx: edit((t) => t.cellDeps.push(ccc.CellDep.from({ outPoint: { txHash: `0x${"6b".repeat(32)}`, index: 0 }, depType: "code" }))) });
  add("random witness", { tx: edit((t) => (t.witnesses = [ccc.hexFrom(new Uint8Array(33).fill(7))])) });
  const other = ccc.Script.from({ ...ccc.Script.from(v.lock), args: "0x" + "11".repeat(20) });
  add("another lock claimed", { lock: other });
  // The template for that other lock, with the vector's witness: the template passes, the lock refuses.
  const f = parseMessage(v.message);
  const otherText = message({ domain: f.domain, account: f.account, lock: other, chain: f.chain, issuedAt: f.issuedAt, nonce: f.nonce });
  const otherTx = proofTemplate(other, otherText);
  otherTx.cellDeps = tx.cellDeps;
  otherTx.witnesses = tx.witnesses;
  add("the witness on another lock's template", { lock: other, message: otherText, tx: otherTx, expect: expectFor(otherText) });
  for (const [name, c] of Object.entries(v.controls ?? {})) add(`control ${name}`, { tx: ccc.Transaction.from(c.tx) });
}

const verdict = (r: Awaited<ReturnType<typeof verify>>) => (r.ok ? { ok: true, cycles: String(r.cycles) } : { ok: false, reason: r.reason });

console.log(`${cases.length} cases`);
const ts: unknown[] = [];
for (const c of cases) {
  try {
    ts.push(verdict(await verify({ lock: c.lock, message: c.message, tx: c.tx }, { rpcUrl: RPC[c.net], runLock: runners[c.net], expect: c.expect })));
  } catch (e) {
    ts.push({ error: String(e) });
  }
}

const dir = mkdtempSync(join(tmpdir(), "ward-compare-"));
const file = join(dir, "cases.json");
const plain = (o: unknown) => JSON.parse(JSON.stringify(o, (_, x) => (typeof x === "bigint" ? `0x${x.toString(16)}` : x)));
writeFileSync(
  file,
  JSON.stringify(
    cases.map((c) => ({
      rpc: RPC[c.net],
      lock: plain(ccc.Script.from(c.lock)),
      message: c.message,
      tx: plain(c.tx),
      expect: { ...c.expect, chain: ccc.hexFrom(c.expect.chain), now: c.expect.now!.toISOString() },
    })),
  ),
);
const wslPath = file.replace(/^([A-Za-z]):\\/, (_, d) => `/mnt/${d.toLowerCase()}/`).replace(/\\/g, "/");
const out = execFileSync(
  "wsl",
  ["-d", DISTRO, "-u", "root", "--", "bash", "-c", `source /root/.cargo/env && cd /mnt/d/Repos/ckb-ward/rust && CARGO_TARGET_DIR=/root/ward-rs-target cargo run -q --release --example verify < ${wslPath}`],
  { encoding: "utf8", maxBuffer: 1 << 26 },
);
const rs = out.trim().split("\n").map((l) => JSON.parse(l));

let same = 0;
const diffs: string[] = [];
const tally: Record<string, number> = {};
cases.forEach((c, i) => {
  // Key order aside; and "ward-vm: " is the TypeScript runner's prefix to what the VM says.
  const norm = (o: any) => JSON.stringify(Object.fromEntries(Object.entries(o).filter(([k]) => k !== "cellDeps").sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, typeof x === "string" ? x.replace("lock did not run: ward-vm: ", "lock did not run: ") : x])));
  const a = JSON.parse(norm(ts[i]));
  const b = JSON.parse(norm(rs[i]));
  const key = a.ok ? "accepted" : a.reason ?? "error";
  tally[key.replace(/0x[0-9a-f]{64}/g, "0x..").replace(/:\d+/, ":n")] = (tally[key.replace(/0x[0-9a-f]{64}/g, "0x..").replace(/:\d+/, ":n")] ?? 0) + 1;
  if (JSON.stringify(a) === JSON.stringify(b)) same++;
  else diffs.push(`${c.name}\n  ts:   ${JSON.stringify(a)}\n  rust: ${JSON.stringify(b)}`);
});
console.log(Object.entries(tally).sort((x, y) => y[1] - x[1]).map(([k, n]) => `${String(n).padStart(4)}  ${k}`).join("\n"));
console.log(`\nsame verdict: ${same} of ${cases.length}`);
if (diffs.length) {
  console.log(`\ndifferent:\n${diffs.join("\n")}`);
  process.exit(1);
}
