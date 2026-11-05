// Offline: what the npm package exposes. `ckb-ward/wallet` is for wallets and sites in a browser, so
// nothing it imports may reach a Node built-in (the runner spawns ckb-debugger and writes files).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import * as all from "../src/index.ts";
import * as wallet from "../src/wallet.ts";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("the wallet entry imports no Node built-in, however deep", () => {
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
  walk("wallet.ts");
  assert.deepEqual([...seen].sort(), ["message.ts", "template.ts", "wallet.ts"]);
  // Control: the full entry does reach one, through the runner.
  assert.match(src("runner.ts"), /from "node:child_process"/);
});

test("the wallet entry is the same functions as the full one", () => {
  for (const [name, value] of Object.entries(wallet)) assert.equal(value, (all as Record<string, unknown>)[name], name);
  assert.equal("verify" in wallet, false);
  assert.equal("ckbDebugger" in wallet, false);
});

test("package.json publishes both entries, built", () => {
  assert.equal(pkg.private, undefined, "publishable");
  assert.deepEqual(Object.keys(pkg.exports), [".", "./wallet"]);
  if (!existsSync(new URL("../dist/index.js", import.meta.url))) return;
  for (const e of Object.values(pkg.exports) as { types: string; default: string }[]) {
    assert.ok(existsSync(new URL(`../${e.default}`, import.meta.url)), e.default);
    assert.ok(existsSync(new URL(`../${e.types}`, import.meta.url)), e.types);
  }
});
