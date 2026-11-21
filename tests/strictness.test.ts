// Offline: what verify() refuses before it reads the chain. Each refusal comes with its control: the
// same proof with the one thing put right reaches the nonce claim, so the refusal is that one thing.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { MAX_RPC_RESPONSE_BYTES, daoWeightAt, depsLiveAt, indexerReaches, jsonRpc, message, parseMessage, parseWardVmRun, proofTemplate, readProof, verify } from "../src/index.ts";
import { expectFor, vectors } from "./helpers.ts";

const v = vectors.find((x) => x.file === "secp256k1.json")!;
const expect = expectFor(v.message);
const never = async () => ({ code: 0, output: "" });

/** Verifies with a claim callback that says "already used": a proof that gets that far passed every free check. */
async function reaches(tx: unknown, over: Partial<Parameters<typeof verify>[1]> = {}, lock: unknown = v.lock) {
  let claimed = false;
  const r = await verify({ lock: lock as ccc.ScriptLike, message: v.message, tx: tx as ccc.TransactionLike }, {
    rpcUrl: "http://127.0.0.1:1",
    runLock: never,
    expect,
    claimNonce: () => {
      claimed = true;
      return false;
    },
    ...over,
  });
  return { r, claimed };
}
const plain = () => JSON.parse(JSON.stringify(v.tx));
const refusal = (x: { r: Awaited<ReturnType<typeof verify>> }) => (x.r.ok ? "ACCEPTED" : x.r.reason);

test("control: the unchanged vector passes every free check", async () => {
  const x = await reaches(plain());
  assert.equal(x.claimed, true);
  assert.equal(refusal(x), "nonce already used");
});

test("an expected time that is not a date is refused, not skipped", async () => {
  const bad = await reaches(plain(), { expect: { ...expect, now: new Date("not a date") } });
  assert.equal(refusal(bad), "expect.now must be a valid Date");
  assert.equal(bad.claimed, false);
  assert.equal((await reaches(plain(), { expect: { ...expect, now: new Date(expect.now!) } })).claimed, true);
});

test("an output capacity below the template is refused, not raised by the parser", async () => {
  const template = proofTemplate(v.lock, v.message).outputs[0].capacity;
  for (const capacity of [0n, template - 1n]) {
    const tx = plain();
    tx.outputs[0].capacity = ccc.numToHex(capacity);
    const x = await reaches(tx);
    assert.equal(refusal(x), "not the proof template for this lock and message", `capacity ${capacity}`);
    assert.equal(x.claimed, false);
  }
  const tx = plain();
  tx.outputs[0].capacity = ccc.numToHex(template);
  assert.equal((await reaches(tx)).claimed, true, "control: the template's own capacity");
});

test("a since the parser would change is refused", async () => {
  const tx = plain();
  tx.inputs[0].since = "0x1000000000000000";
  const x = await reaches(tx);
  assert.ok(!x.claimed);
  assert.match(refusal(x), /^(not the proof template|malformed proof)/);
  const ok = plain();
  ok.inputs[0].since = "0x0";
  assert.equal((await reaches(ok)).claimed, true, "control: the same since written canonically");
});

test("JSON that is not in the canonical form is refused as malformed", async () => {
  const cases: [string, (t: any) => void, string][] = [
    ["since with a leading zero", (t) => (t.inputs[0].since = "0x00"), "inputs[0].since is not canonical 0x hex"],
    ["a cell dep index with a leading zero", (t) => (t.cellDeps[0].outPoint.index = "0x00"), "cellDeps[0].outPoint.index is not canonical 0x hex"],
    ["a cell dep index above u32", (t) => (t.cellDeps[0].outPoint.index = "0x100000000"), "cellDeps[0].outPoint.index is out of range"],
    ["a witness without 0x", (t) => (t.witnesses[0] = t.witnesses[0].slice(2)), "witnesses[0] is not 0x hex bytes"],
    ["a witness of odd length", (t) => (t.witnesses[0] = t.witnesses[0] + "0"), "witnesses[0] is not 0x hex bytes"],
    ["a witness with a capital X", (t) => (t.witnesses[0] = "0X" + t.witnesses[0].slice(2)), "witnesses[0] is not 0x hex bytes"],
    ["a tx hash of 31 bytes", (t) => (t.cellDeps[0].outPoint.txHash = t.cellDeps[0].outPoint.txHash.slice(0, -2)), "cellDeps[0].outPoint.txHash is not 32 bytes"],
    ["a version above u32", (t) => (t.version = "0x100000000"), "version is out of range"],
    ["a negative since", (t) => (t.inputs[0].since = -1), "inputs[0].since is not a non-negative integer"],
    ["a since above u64", (t) => (t.inputs[0].since = "0x10000000000000000"), "inputs[0].since is out of range"],
    ["a capacity above u64", (t) => (t.outputs[0].capacity = "0x10000000000000000"), "outputs[0].capacity is out of range"],
    ["a missing list", (t) => delete t.cellDeps, "cellDeps is not a list"],
    ["outputsData also written outputs_data", (t) => (t.outputs_data = ["0x"]), "the key outputsData is written twice (camelCase and snake_case)"],
    ["a cell dep with depType also dep_type", (t) => (t.cellDeps[0].dep_type = "code"), "the key depType is written twice (camelCase and snake_case)"],
    ["a dep type in the RPC spelling", (t) => (t.cellDeps[0].depType = "dep_group"), "cellDeps[0].depType is not code or depGroup"],
    ["a transaction that is a list", () => {}, "transaction is not an object"],
  ];
  for (const [name, edit, why] of cases) {
    const tx = plain();
    edit(tx);
    const x = await reaches(name === "a transaction that is a list" ? [] : tx);
    assert.equal(refusal(x), `malformed proof: ${why}`, name);
    assert.equal(x.claimed, false, name);
  }
  // Controls: other spellings of the same values are the same transaction.
  for (const edit of [(t: any) => (t.inputs[0].since = 0), (t: any) => (t.cellDeps[0].outPoint.index = 0), (t: any) => (t.witnesses[0] = "0x" + t.witnesses[0].slice(2).toUpperCase())]) {
    const tx = plain();
    edit(tx);
    assert.equal((await reaches(tx)).claimed, true);
  }
});

test("a lock that is not in the canonical form is refused as malformed", async () => {
  const bad = { ...v.lock, args: (v.lock as any).args.slice(2) } as any;
  assert.equal(refusal(await reaches(plain(), {}, bad)), "malformed proof: lock.args is not 0x hex bytes");
  const twin = { ...v.lock, code_hash: (v.lock as any).codeHash } as any;
  assert.equal(refusal(await reaches(plain(), {}, twin)), "malformed proof: the key codeHash is written twice (camelCase and snake_case)");
});

test("a transaction with no input or no output is refused, not thrown at", async () => {
  for (const edit of [(t: any) => (t.inputs = []), (t: any) => (t.outputs = []), (t: any) => ((t.outputs = []), (t.outputsData = []))]) {
    const tx = plain();
    edit(tx);
    const x = await reaches(tx);
    assert.equal(refusal(x), "not the proof template for this lock and message");
  }
});

test("Issued at must be a time that exists", () => {
  const lock = { codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x00" } as const;
  const chain = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
  const at = (issuedAt: string) => message({ domain: "dao.example", account: "a", lock, chain, issuedAt, nonce: "n" });
  for (const bad of ["2026-02-29T00:00:00Z", "2026-02-30T00:00:00Z", "2026-04-31T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T24:00:00.000Z", "1900-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-00-10T00:00:00Z", "2026-01-00T00:00:00Z", "2026-01-01T23:60:00Z", "2026-01-01T23:59:60Z"]) {
    assert.throws(() => at(bad), /bad issued at/, bad);
    const text = at("2026-01-01T00:00:00Z").replace("2026-01-01T00:00:00Z", bad);
    assert.throws(() => parseMessage(text), /bad issued at/, `parse ${bad}`);
  }
  for (const ok of ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-04-30T23:59:59Z", "2026-12-31T23:59:59.123456789Z", "0000-01-01T00:00:00Z"]) assert.equal(parseMessage(at(ok)).issuedAt, ok);
});

test("readProof refuses a message whose lock hash line is another lock", () => {
  const a = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" + "11".repeat(20) });
  const b = ccc.Script.from({ codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x" + "22".repeat(20) });
  const f = parseMessage(v.message);
  const textA = message({ domain: f.domain, account: f.account, lock: a, chain: f.chain, issuedAt: f.issuedAt, nonce: f.nonce });
  assert.ok(readProof(proofTemplate(a, textA), a), "control: the message and the lock agree");
  // The transaction is for lock b and carries a message that shows lock a's hash: a person would be told one lock and sign for another.
  assert.equal(readProof(proofTemplate(b, textA), b), undefined);
});

test("the reason a lock did not run is said in words, as the Rust verifier says it", () => {
  const exited = { status: 0, stdout: '{"code":null,"error":"ExceededMaximumCycles"}\n', stderr: "" };
  assert.deepEqual(parseWardVmRun(exited), { code: null, output: "ExceededMaximumCycles" });
  const failed = { status: 2, stdout: "", stderr: "ward-vm: ScriptNotFound: code_hash: Byte32(0x00)\n" };
  assert.deepEqual(parseWardVmRun(failed), { code: null, output: "ScriptNotFound: code_hash: Byte32(0x00)" });
  assert.equal(parseWardVmRun({ status: 0, stdout: '{"code":-31,"cycles":"1645417"}\n', stderr: "" }).code, -31);
});

/** An answer sent as written. */
class Raw {
  text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** A node that answers every call with `answer(method)`, and counts the calls. */
async function node(answer: (method: string, params: any) => unknown) {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params, id } = JSON.parse(body);
      calls.push(method);
      const out = answer(method, params);
      if (out instanceof Raw) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(out.text);
      } else res.end(JSON.stringify({ jsonrpc: "2.0", id, result: out }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test("an answer larger than the cap is refused before it is buffered, a smaller one is read", async () => {
  const big = await node(() => new Raw(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "x".repeat(MAX_RPC_RESPONSE_BYTES + 1) })));
  const small = await node(() => "y".repeat(1024 * 1024));
  try {
    await assert.rejects(jsonRpc(big.url)("get_tip_header", []), /larger than/);
    assert.equal((await jsonRpc(small.url)("get_tip_header", [])).length, 1024 * 1024, "control: 1 MB is read");
  } finally {
    await big.close();
    await small.close();
  }
});

test("reads stop at the deadline: a call that would start after it never reaches the node", async () => {
  const n = await node(() => "0x1");
  try {
    assert.equal(await jsonRpc(n.url, 5000, Date.now() + 5000)("get_tip_header", []), "0x1", "control: time left");
    await assert.rejects(jsonRpc(n.url, 5000, Date.now() - 1)("get_tip_header", []), /time allowed/);
    assert.equal(n.calls.length, 1, "the late call was not sent");
  } finally {
    await n.close();
  }
});

test("the indexer must have reached the block asked for", async () => {
  const lag = await node((m) => (m === "get_tip_header" ? { number: "0x64" } : m === "get_indexer_tip" ? { block_number: "0x50", block_hash: "0x" } : null));
  const ok = await node((m) => (m === "get_indexer_tip" ? { block_number: "0x64", block_hash: "0x" } : null));
  try {
    await assert.rejects(indexerReaches(jsonRpc(lag.url), 100n), /indexer is at block 80, behind the snapshot block 100/);
    await indexerReaches(jsonRpc(ok.url), 100n); // control: caught up
    await indexerReaches(jsonRpc(ok.url), 99n);
    const lock = ccc.Script.from(v.lock);
    await assert.rejects(daoWeightAt(lag.url, lock, 100n), /behind the snapshot/);
    await assert.rejects(depsLiveAt(lag.url, [{ txHash: `0x${"11".repeat(32)}`, index: 0 }], 100n), /behind the snapshot/);
    assert.ok(!lag.calls.includes("get_transactions"), "no search by script ran on a lagging indexer");
  } finally {
    await lag.close();
    await ok.close();
  }
});
