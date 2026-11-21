// End to end on testnet: the Rust example server (examples/bind_server.rs) issues the nonce, the
// message and the template; CCC's own signers, with fresh random keys, sign the template as a wallet
// would; the server verifies the signed proof against the live chain. Nothing is sent or spent.
//
// Start the server, then run this from the repository root:
//   cargo run --release --example bind_server -- 8787        (in rust/)
//   node rust/scripts/e2e.ts [http://127.0.0.1:8787]
//
// For each lock: the proof is accepted; the same nonce again is refused before any chain read; one
// bit flipped in the signature is refused by the lock; a second key signing for the first key's
// lock is refused by the lock. ethers and @noble/curves come with @ckb-ccc/core.
import { randomBytes } from "node:crypto";
import { ccc } from "@ckb-ccc/core";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { Wallet } from "ethers";

const BASE = process.argv[2] ?? "http://127.0.0.1:8787";
const client = new ccc.ClientPublicTestnet({ url: "https://testnet.ckb.dev/rpc" });
const key = () => ccc.hexFrom(randomBytes(32));

async function post(path: string, body: unknown) {
  const res = await fetch(BASE + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return res.json() as Promise<any>;
}

class EvmKey extends ccc.SignerEvm {
  readonly wallet: Wallet;
  readonly account?: string;
  constructor(priv: string, account?: string) {
    super(client);
    this.wallet = new Wallet(priv);
    this.account = account;
  }
  async connect() {}
  async isConnected() {
    return true;
  }
  async getEvmAccount() {
    return (this.account ?? this.wallet.address).toLowerCase() as ccc.Hex;
  }
  async signMessageRaw(msg: string | ccc.BytesLike) {
    return this.wallet.signMessage(typeof msg === "string" ? msg : ccc.bytesFrom(msg));
  }
}
class BtcKey extends ccc.SignerBtc {
  readonly priv: Uint8Array;
  readonly pub: Uint8Array;
  readonly asKey?: ccc.Hex;
  constructor(priv: string, asKey?: ccc.Hex) {
    super(client);
    this.priv = ccc.bytesFrom(priv);
    this.pub = secp256k1.getPublicKey(this.priv, true);
    this.asKey = asKey;
  }
  async connect() {}
  async isConnected() {
    return true;
  }
  async getBtcAccount() {
    return `test-${ccc.hexFrom(this.pub).slice(2, 12)}`;
  }
  async getBtcPublicKey() {
    return this.asKey ?? ccc.hexFrom(this.pub);
  }
  async signMessageRaw(msg: string | ccc.BytesLike) {
    const challenge = typeof msg === "string" ? msg : ccc.hexFrom(msg).slice(2);
    const sig = secp256k1.sign(ccc.messageHashBtcEcdsa(challenge), this.priv, { format: "recovered", prehash: false });
    return ccc.bytesTo(ccc.bytesConcat([31 + Number(sig[0])], sig.subarray(1)), "base64");
  }
  async signPsbt(): Promise<ccc.Hex> {
    throw new Error("not used");
  }
  async broadcastPsbt(): Promise<ccc.Hex> {
    throw new Error("not used");
  }
}
/** A CKB key that signs as if the given lock were its own: the wrong-key control. */
class CkbAs extends ccc.SignerCkbPrivateKey {
  readonly as: ccc.Script;
  constructor(priv: string, as: ccc.Script) {
    super(client, priv);
    this.as = as;
  }
  async getAddressObjSecp256k1() {
    return ccc.Address.from({ prefix: client.addressPrefix, script: this.as });
  }
}
class NostrAs extends ccc.SignerNostrPrivateKey {
  readonly as: ccc.Script;
  constructor(priv: string, as: ccc.Script) {
    super(client, priv);
    this.as = as;
  }
  async getRecommendedAddressObj() {
    return ccc.Address.from({ prefix: client.addressPrefix, script: this.as });
  }
}
class DogeAs extends ccc.SignerDogePrivateKey {
  readonly as: ccc.Script;
  constructor(priv: string, as: ccc.Script) {
    super(client, priv);
    this.as = as;
  }
  async getRecommendedAddressObj() {
    return ccc.Address.from({ prefix: client.addressPrefix, script: this.as });
  }
}

type Sign = (template: ccc.Transaction) => Promise<ccc.Transaction>;
const signWith = (s: ccc.Signer): Sign => async (t) => s.signOnlyTransaction(await s.prepareTransaction(t));

interface Lock {
  name: string;
  lock: ccc.Script;
  sign: Sign;
  wrong: Sign;
  sigByte: number;
}

async function locks(): Promise<Lock[]> {
  const out: Lock[] = [];
  const k1 = key();
  const ckb = new ccc.SignerCkbPrivateKey(client, k1);
  const secp = (await ckb.getAddressObjSecp256k1()).script;
  out.push({ name: "secp256k1", lock: secp, sign: signWith(ckb), wrong: signWith(new CkbAs(key(), secp)), sigByte: 30 });

  const acp = (await ccc.Address.fromKnownScript(client, ccc.KnownScript.AnyoneCanPay, secp.args)).script;
  // The wrong key gets the real signer's deps (the anyone-can-pay code), so only the signature differs.
  const acpOther = new CkbAs(key(), acp);
  out.push({ name: "anyone-can-pay", lock: acp, sign: signWith(ckb), wrong: async (t) => acpOther.signOnlyTransaction(await ckb.prepareTransaction(t)), sigByte: 30 });

  const ks = [key(), key(), key()];
  const info = { publicKeys: ks.map((k) => new ccc.SignerCkbPrivateKey(client, k).publicKey), threshold: 2 };
  const m = ks.map((k) => new ccc.SignerMultisigCkbPrivateKey(client, k, info));
  const multisig = (await m[0].getRecommendedAddressObj()).script;
  const two = (a: ccc.SignerMultisigCkbPrivateKey, b: ccc.SignerMultisigCkbPrivateKey): Sign => async (t) => b.signOnlyTransaction(await a.signOnlyTransaction(await a.prepareTransaction(t)));
  const outsider = new ccc.SignerMultisigCkbPrivateKey(client, key(), info);
  out.push({ name: "multisig 2 of 3", lock: multisig, sign: two(m[0], m[2]), wrong: two(m[0], outsider), sigByte: 80 });

  const nostr = new ccc.SignerNostrPrivateKey(client, key());
  const nostrLock = (await nostr.getRecommendedAddressObj()).script;
  out.push({ name: "Nostr lock", lock: nostrLock, sign: signWith(nostr), wrong: signWith(new NostrAs(key(), nostrLock)), sigByte: 20 });

  const doge = new ccc.SignerDogePrivateKey(client, key());
  const dogeLock = (await doge.getRecommendedAddressObj()).script;
  out.push({ name: "Omnilock, Dogecoin", lock: dogeLock, sign: signWith(doge), wrong: signWith(new DogeAs(key(), dogeLock)), sigByte: 80 });

  const evm = new EvmKey(key());
  const evmLock = (await evm.getRecommendedAddressObj()).script;
  out.push({ name: "Omnilock, Ethereum", lock: evmLock, sign: signWith(evm), wrong: signWith(new EvmKey(key(), await evm.getEvmAccount())), sigByte: 80 });

  const btc = new BtcKey(key());
  const btcLock = (await btc.getRecommendedAddressObj()).script;
  out.push({ name: "Omnilock, Bitcoin", lock: btcLock, sign: signWith(btc), wrong: signWith(new BtcKey(key(), ccc.hexFrom(btc.pub))), sigByte: 80 });

  const pw = new EvmKey(key());
  const pwLock = (await ccc.Address.fromKnownScript(client, ccc.KnownScript.PWLock, await pw.getEvmAccount())).script;
  out.push({ name: "PW-lock", lock: pwLock, sign: signWith(pw), wrong: signWith(new EvmKey(key(), await pw.getEvmAccount())), sigByte: 30 });
  return out;
}

const flip = (t: ccc.Transaction, at: number) => {
  const c = t.clone();
  const w = ccc.bytesFrom(c.witnesses[0]).slice();
  w[at] ^= 1;
  c.witnesses[0] = ccc.hexFrom(w);
  return c;
};

async function proofFor(l: Lock, account: string, sign: Sign) {
  const issued = await post("/nonce", { account, lock: { codeHash: l.lock.codeHash, hashType: l.lock.hashType, args: l.lock.args } });
  if (issued.error) throw new Error(`nonce: ${issued.error}`);
  const signed = await sign(ccc.Transaction.from(issued.template));
  return { nonce: issued.nonce as string, tx: signed };
}

const txJson = (t: ccc.Transaction) => JSON.parse(t.stringify());
let failures = 0;
const check = (what: string, got: any, ok: (r: any) => boolean) => {
  const pass = ok(got);
  if (!pass) failures++;
  console.log(`${pass ? "PASS" : "FAIL"}  ${what}: ${got.ok ? `accepted, ${got.cycles} cycles` : (got.reason ?? got.error)}`);
};

for (const l of await locks()) {
  const account = `user-${l.name.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
  const good = await proofFor(l, account, l.sign);
  const r = await post("/bind", { nonce: good.nonce, tx: txJson(good.tx) });
  check(`${l.name}: signed proof`, r, (x) => x.ok === true && x.account === account && x.lockHash === l.lock.hash());
  check(`${l.name}: the same nonce again`, await post("/bind", { nonce: good.nonce, tx: txJson(good.tx) }), (x) => x.reason === "nonce already used");
  const flipped = await proofFor(l, account, l.sign);
  check(`${l.name}: one signature bit flipped`, await post("/bind", { nonce: flipped.nonce, tx: txJson(flip(flipped.tx, l.sigByte)) }), (x) => x.ok === false && /^lock exited /.test(x.reason));
  const wrong = await proofFor(l, account, l.wrong);
  check(`${l.name}: another key signs for this lock`, await post("/bind", { nonce: wrong.nonce, tx: txJson(wrong.tx) }), (x) => x.ok === false && /^lock exited /.test(x.reason));
}
const bindings = await (await fetch(BASE + "/bindings")).json();
console.log(`\nbindings on the server: ${bindings.length}`);
if (failures) {
  console.log(`${failures} failed`);
  process.exit(1);
}
console.log("all passed");
