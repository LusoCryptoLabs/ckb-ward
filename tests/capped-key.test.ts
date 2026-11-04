// A Cellula smart account whose Config Cell lists keys with a per-transaction cap. Such a key must
// not be able to prove the account: the verifier resolves the proof input with capacity u64::MAX,
// so the lock sees the whole account leave. The lock code, auth_libecc and the header of the Config
// Cell are the real testnet ones from the guarded vector; the Config Cell itself is fabricated in
// the local stub (what a real one looks like after the owner adds capped keys). Nothing is sent.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { jsonRpc, message, mockTransaction, proofInput, proofTemplate, resolveCellDeps, verify } from "../src/index.ts";
import { NO_VM, RPC_URL, runLock, vectors } from "./helpers.ts";
import { TESTNET_GENESIS, startStub } from "./stub.ts";

const V5 = vectors.find((x) => x.file === "smart-account-guarded.json")!;
const sha256 = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const u16 = (n: number) => Uint8Array.of((n >> 8) & 255, n & 255);
const fromB64url = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

interface Key {
  privateKey: KeyObject;
  pub64: Uint8Array;
  authHash: Uint8Array;
}

function p256Key(): Key {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const pub64 = ccc.bytesConcat(fromB64url(jwk.x!), fromB64url(jwk.y!));
  return { privateKey, pub64, authHash: ccc.bytesFrom(ccc.hashCkb(pub64)).slice(0, 20) };
}

/** ECDSA P-256 over SHA-256(data), r || s with low s. */
function signP256(key: Key, data: Uint8Array): Uint8Array {
  const sig = sign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" });
  let s = BigInt(`0x${sig.subarray(32).toString("hex")}`);
  if (s > P256_N / 2n) s = P256_N - s;
  return ccc.bytesConcat(sig.subarray(0, 32), ccc.numBeToBytes(s, 32));
}

/** One authenticator record of the Config Cell: 0xfe, blake160 of the key, cap (u64 BE), auth code hash. */
function record(k: Key, capCkb: bigint, authCodeHash: Uint8Array): Uint8Array {
  return ccc.bytesConcat([0xfe], k.authHash, ccc.numBeToBytes(capCkb * 100000000n, 8), authCodeHash);
}

/** The wallet's WebAuthn witness: mode 0 (spend), authenticator index, length, then the 512 byte field. */
async function signProof(tx: ccc.Transaction, account: ccc.Script, k: Key, index: number): Promise<ccc.Transaction> {
  const client = new ccc.ClientPublicTestnet();
  await tx.prepareSighashAllWitness(account, 4 + 512, client);
  const info = (await tx.getSignHashInfo(account, client))!;
  const bound = ccc.bytesFrom(ccc.hashCkb(ccc.bytesConcat(info.message, account.hash())));
  const authData = new Uint8Array(37);
  authData.set(sha256(ccc.bytesFrom("wallet.testnet.cellula.id", "utf8")));
  authData[32] = 0x05;
  const cd = ccc.bytesFrom(`{"type":"webauthn.get","challenge":"${Buffer.from(bound).toString("base64url")}","origin":"https://wallet.testnet.cellula.id"}`, "utf8");
  const field = new Uint8Array(512);
  field.set(ccc.bytesConcat(u16(37), authData, u16(cd.length), cd, k.pub64, signP256(k, ccc.bytesConcat(authData, sha256(cd)))));
  const w = tx.getWitnessArgsAt(info.position)!;
  w.lock = ccc.hexFrom(ccc.bytesConcat([0, index], u16(512), field));
  tx.setWitnessArgsAt(info.position, w);
  return tx;
}

test("smart account: a capped key cannot prove the account, an unlimited key can", { skip: NO_VM }, async (t) => {
  // The real Config Cell of the guarded vector gives the header layout and the auth code hash.
  const real = await jsonRpc(RPC_URL)("get_live_cell", [JsonRpcTransformers.outPointFrom(ccc.Transaction.from(V5.tx).cellDeps[3].outPoint), true]);
  const cb = ccc.bytesFrom(real.cell.data.content);
  assert.equal(cb[45], 0xfe, "authenticator 0 of the real Config Cell is a passkey");
  const authCodeHash = cb.slice(45 + 29, 45 + 61);

  const main = p256Key(), cap100 = p256Key(), cap1000 = p256Key(), stranger = p256Key(), guardian = p256Key();
  const header = new Uint8Array(44);
  header.set(cb.slice(0, 11));
  header[1] = 1; // spend threshold: one key
  header[2] = 1; // recovery threshold
  const config = ccc.bytesConcat(header, [3], record(main, 0n, authCodeHash), record(cap100, 100n, authCodeHash), record(cap1000, 1000n, authCodeHash), [1], record(guardian, 0n, authCodeHash));

  const stub = await startStub({ upstream: RPC_URL });
  try {
    const typeId = ccc.Script.from({ codeHash: "0x00000000000000000000000000000000000000000000000000545950455f4944", hashType: "type", args: ccc.hashCkb(ccc.bytesFrom("ward capped key test", "utf8")) });
    const account = ccc.Script.from({ codeHash: V5.lock.codeHash, hashType: "type", args: typeId.hash() });
    const configOp = stub.fabricate({ capacity: 1000n * 100000000n, lock: account, type: typeId, data: config }, "config");
    const cellDeps = [...ccc.Transaction.from(V5.tx).cellDeps.slice(0, 3), ccc.CellDep.from({ outPoint: configOp, depType: "code" })];

    const results: Record<string, { reason: string; tx: ccc.Transaction; text: string }> = {};
    for (const [name, k, index] of [["unlimited", main, 0], ["cap 100 CKB", cap100, 1], ["cap 1000 CKB", cap1000, 2], ["not in the Config Cell", stranger, 0]] as const) {
      const nonce = `capped-${index}-${name.length}`;
      const text = message({ domain: "dao.example", account: "acct", lock: account, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce });
      const tx = proofTemplate(account, text);
      tx.cellDeps = cellDeps.map((d) => d.clone());
      await signProof(tx, account, k, index);
      const r = await verify({ lock: account, message: text, tx }, { rpcUrl: stub.url, runLock: runLock!, expect: { domain: "dao.example", account: "acct", nonce, maxAgeSeconds: 600 } });
      results[name] = { reason: r.ok ? `ACCEPTED, cycles ${r.cycles}` : r.reason, tx, text };
      t.diagnostic(`${name}: ${results[name].reason}`);
    }
    assert.match(results["unlimited"].reason, /^ACCEPTED/);
    assert.equal(results["cap 100 CKB"].reason, "lock exited 27");
    assert.equal(results["cap 1000 CKB"].reason, "lock exited 27");
    assert.equal(results["not in the Config Cell"].reason, "lock exited 26");

    // Precondition, so the refusal above is the fix and not a bad signature: the template moves
    // (41 + n) CKB to the null lock, under 1000 CKB, and with the input resolved at capacity 0 (the
    // old rule) the lock accepts the same 1000 CKB key's proof.
    const { tx, text } = results["cap 1000 CKB"];
    const outflow = BigInt(41 + ccc.bytesFrom(text, "utf8").length) * 100000000n;
    assert.ok(outflow < 1000n * 100000000n);
    const deps = await resolveCellDeps(stub.url, tx.cellDeps);
    const zero = proofInput(account);
    zero.output.capacity = "0x0";
    const old = await runLock!(mockTransaction(tx, zero, deps));
    const now = await runLock!(mockTransaction(tx, proofInput(account), deps));
    t.diagnostic(`cap 1000 CKB key, run directly: input capacity 0 -> exit ${old.code}; input capacity u64::MAX -> exit ${now.code}`);
    assert.equal(old.code, 0);
    assert.equal(now.code, 27);
  } finally {
    await stub.close();
  }
});
