// Offline: what the npm package exposes. `ckb-ward/wallet` is for wallets and sites in a browser and
// `ckb-ward/browser` for a verifier there, so nothing they import may reach a Node built-in (the
// runner spawns ckb-debugger and writes files).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as all from "../src/index.ts";
import * as browser from "../src/browser.ts";
import * as wallet from "../src/wallet.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Every local module an entry reaches, failing on any Node built-in on the way. */
function reach(entry: string): string[] {
  const seen = new Set<string>();
  const walk = (f: string) => {
    if (seen.has(f)) return;
    seen.add(f);
    for (const m of src(f).matchAll(/^(?:import|export)\b[^;]*?from\s+"([^"]+)"/gm)) {
      const spec = m[1]!;
      assert.ok(!spec.startsWith("node:"), `${f} imports ${spec}`);
      if (spec.startsWith("./")) walk(spec.slice(2));
    }
  };
  walk(entry);
  return [...seen].sort();
}

test("the wallet entry imports no Node built-in, however deep", () => {
  assert.deepEqual(reach("wallet.ts"), ["message.ts", "template.ts", "wallet.ts"]);
  // Control: the full entry does reach one, through the runner.
  assert.match(src("runner.ts"), /from "node:child_process"/);
  assert.throws(() => reach("index.ts"), /runner\.ts imports node:/);
});

test("the browser entry imports no Node built-in, however deep", () => {
  const reached = reach("browser.ts");
  assert.ok(reached.includes("verify.ts") && reached.includes("ckbvmjs.ts"), reached.join(", "));
  assert.ok(!reached.includes("runner.ts"));
});

test("the browser entry is the full one without the process runners", () => {
  for (const [name, value] of Object.entries(browser)) assert.equal(value, (all as Record<string, unknown>)[name], name);
  const missing = Object.keys(all).filter((k) => !(k in browser)).sort();
  assert.deepEqual(missing, ["ckbDebugger", "parseDebuggerRun", "parseWardVmRun", "tipEpoch", "toWslPath", "wardVm"]);
});

test("the wallet entry is the same functions as the full one", () => {
  for (const [name, value] of Object.entries(wallet)) assert.equal(value, (all as Record<string, unknown>)[name], name);
  assert.equal("verify" in wallet, false);
  assert.equal("ckbDebugger" in wallet, false);
});

test("package.json publishes the three entries, built", () => {
  assert.equal(pkg.private, undefined, "publishable");
  assert.deepEqual(Object.keys(pkg.exports), [".", "./wallet", "./browser"]);
  if (!existsSync(new URL("../dist/index.js", import.meta.url))) return;
  for (const e of Object.values(pkg.exports) as { types: string; default: string }[]) {
    assert.ok(existsSync(new URL(`../${e.default}`, import.meta.url)), e.default);
    assert.ok(existsSync(new URL(`../${e.types}`, import.meta.url)), e.types);
  }
});
