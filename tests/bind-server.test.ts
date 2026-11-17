// examples/bind-server: the bind flow a voting platform would run, end to end on testnet with a
// throwaway key, plus the refusals. Needs the testnet RPC and a lock runner (CKB_VM_JS, or WARD_VM /
// WARD_VM_WSL, or CKB_DEBUGGER).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { ccc } from "@ckb-ccc/core";
import { createBindServer, runnerFromEnv } from "../examples/bind-server/server.ts";
import { ckbVmJs, type CkbVmJsVerifier, type RunLock } from "../src/index.ts";
import { NO_NETWORK, RPC_URL, runLock as envRunLock } from "./helpers.ts";

async function runner(): Promise<RunLock | undefined> {
  const pkg = process.env.CKB_VM_JS;
  if (!pkg) return envRunLock;
  const m = await import(pathToFileURL(join(pkg, "js", "index.js")).href);
  const verifier: CkbVmJsVerifier = await m.createVerifier({ wasm: readFileSync(join(pkg, "pkg", "ckb_wasm_verifier_bg.wasm")) });
  return ckbVmJs({ verifier, rpcUrl: RPC_URL });
}
const NO_RUNNER = process.env.CKB_VM_JS || envRunLock ? false : "set CKB_VM_JS, WARD_VM(_WSL) or CKB_DEBUGGER(_WSL)";

test("bind server: the default runner (ckb-vm-js) starts in Node", async () => {
  // ckb-vm-js cannot fetch its own .wasm from a file URL in Node; the server passes the bytes.
  const saved = process.env.RUNNER;
  delete process.env.RUNNER;
  try {
    assert.equal(typeof (await runnerFromEnv("testnet", RPC_URL)), "function");
  } finally {
    if (saved !== undefined) process.env.RUNNER = saved;
  }
});

test("bind server: a wallet binds, a replay and a changed signature are refused", { skip: NO_NETWORK || NO_RUNNER }, async (t) => {
  const server = await createBindServer({ network: "testnet", domain: "vote.example", rpcUrl: RPC_URL, runLock: (await runner())! });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: (await r.json()) as any };
  };
  try {
    const key = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(32)));
    const signer = new ccc.SignerCkbPrivateKey(new ccc.ClientPublicTestnet({ url: RPC_URL }), key);
    const address = (await signer.getRecommendedAddressObj()).toString();

    const req = await post("/bind/request", { account: "user-42", address });
    assert.equal(req.status, 200);
    assert.match(req.json.message, /^vote\.example wants you to prove control of a CKB lock\./);
    const signed = await signer.signTransaction(ccc.Transaction.from(req.json.template));
    const tx = JSON.parse(signed.stringify());

    // Control: one byte of the signature changed, on a request of its own (a request is used once,
    // accepted or refused). The lock itself refuses it.
    const req2 = await post("/bind/request", { account: "user-42", address });
    const signed2 = await signer.signTransaction(ccc.Transaction.from(req2.json.template));
    const w = ccc.bytesFrom(signed2.witnesses[0]!).slice();
    w[w.length - 10] ^= 1;
    signed2.witnesses[0] = ccc.hexFrom(w);
    const flipped = await post("/bind/verify", { nonce: req2.json.nonce, tx: JSON.parse(signed2.stringify()) });
    t.diagnostic(`changed signature: ${flipped.status} ${flipped.json.reason}`);
    assert.equal(flipped.status, 400);
    assert.match(flipped.json.reason, /^lock exited -31$/);
    assert.equal((await post("/bind/verify", { nonce: req2.json.nonce, tx: JSON.parse(signed2.stringify()) })).status, 404, "a refused request is used up too");

    const ok = await post("/bind/verify", { nonce: req.json.nonce, tx });
    t.diagnostic(`proof: ${ok.status} ${JSON.stringify(ok.json).slice(0, 160)}`);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.ok, true);
    assert.equal(ok.json.account, "user-42");
    assert.equal(ok.json.address, address);
    assert.equal(ok.json.lockHash, (await signer.getRecommendedAddressObj()).script.hash());

    const replay = await post("/bind/verify", { nonce: req.json.nonce, tx });
    assert.equal(replay.status, 404);
    assert.match(replay.json.reason, /unknown or used nonce/);

    // A mainnet address on a testnet server, and the weight of a fresh address.
    // The same key's mainnet address: valid on mainnet (precondition), refused by a testnet server.
    const mainClient = new ccc.ClientPublicMainnet();
    const mainAddress = (await new ccc.SignerCkbPrivateKey(mainClient, key).getRecommendedAddressObj()).toString();
    assert.ok(await ccc.Address.fromString(mainAddress, mainClient));
    const main = await post("/bind/request", { account: "user-42", address: mainAddress });
    assert.equal(main.status, 400);
    assert.equal(main.json.reason, "not a testnet address");
    const tip = BigInt((await (await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "get_tip_header", params: [] }) })).json()).result.number);
    const weight = await fetch(`${base}/weight?address=${address}&block=${tip - 10n}`);
    assert.equal(weight.status, 200);
    assert.deepEqual(await weight.json(), { weight: "0", deposits: 0, withdrawing: 0 });
  } finally {
    server.close();
  }
});
