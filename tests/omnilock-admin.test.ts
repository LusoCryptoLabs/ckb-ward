// Omnilock in administrator mode. The args carry the type hash of an admin list cell (RC cell); a
// witness that names an identity on that list, with an SMT proof, is checked against that
// identity's signature instead of the owner's. The lock code is the real testnet Omnilock; the RC
// cell is fabricated in the local stub (an administrator creates and controls it, so a real one
// looks the same). Keys are fresh and random. Nothing is sent to any chain.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { message, mockTransaction, proofInput, proofTemplate, resolveCellDeps, verify, type VerifyResult } from "../src/index.ts";
import { NO_VM, RPC_URL, expectFor, otherMessage, runLock } from "./helpers.ts";
import { TESTNET_GENESIS, startStub } from "./stub.ts";

const TYPE_ID = "0x00000000000000000000000000000000000000000000000000545950455f4944";
const SECP256K1 = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const SECP256K1_DEP_GROUP = { outPoint: { txHash: "0xf8de3bb47d055cdf460d93a2a6e1b05f7432f9777c8c474abf4eec1d4aee5d37", index: 0 }, depType: "depGroup" } as const;

/** The two live testnet Omnilock deployments, and what the owner's own proof gives on each. */
const DEPLOYMENTS = [
  {
    // The one CCC uses. Code data hash 0x6b29b6f1..., deployed 2024-04-12.
    name: "Omnilock (CCC testnet)",
    codeHash: "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb",
    deps: [SECP256K1_DEP_GROUP, { outPoint: { txHash: "0xec18bf0d857c981c3d1f4e17999b9b90c484b303378e94de1a57b0872f5d4602", index: 0 }, depType: "code" }],
    ownerExit: 0,
  },
  {
    // Code data hash 0x1bf147d1..., deployed 2022. Measured: the owner's proof on a lock with the
    // admin flag stops the VM ("memory error: write on executable page", script versions 0 to 2),
    // while the same owner without the flag exits 0. Not investigated further.
    name: "Omnilock (2022 testnet)",
    codeHash: "0x79f90bb5e892d80dd213439eeab551120eb417678824f282b4ffb5f21bad2e1e",
    deps: [SECP256K1_DEP_GROUP, { outPoint: { txHash: "0x9154df4f7336402114d04495175b37390ce86a4906d2d4001cf02c3e6d97f39c", index: 0 }, depType: "code" }],
    ownerExit: null,
  },
] as const;

// Molecule, as omni_lock.mol and xudt_rce.mol define the types used here.
const u32 = (n: number) => ccc.numLeToBytes(n, 4);
const fixvec = (b: ccc.BytesLike) => ccc.bytesConcat(u32(ccc.bytesFrom(b).length), b);
/** A table, or a dynvec: total size, one offset per item, the items. */
function table(items: Uint8Array[]): Uint8Array {
  let at = 4 + 4 * items.length;
  const offsets = items.map((i) => {
    const o = u32(at);
    at += i.length;
    return o;
  });
  return ccc.bytesConcat(u32(at), ...offsets, ...items);
}

/** The SMT key of an identity: flags, blake160, zero padding. */
const smtKey = (auth: Uint8Array) => ccc.bytesConcat(auth, new Uint8Array(11));
/** A whitelist leaf's value. */
const WL_VALUE = ccc.bytesConcat([1], new Uint8Array(31));
/** The proof for a tree with one leaf: push the leaf (0x4c), merge it with zeros 256 times (0x4f 0x00). */
const ONE_LEAF_PROOF = Uint8Array.of(0x4c, 0x4f, 0x00);
const bit = (b: Uint8Array, i: number) => (b[i >> 3] >> (i & 7)) & 1;

/**
 * Root of a tree whose only leaf is (key, value), as ckb_smt.h's smt_calculate_root computes it
 * for ONE_LEAF_PROOF: the leaf merged with a zero sibling at every height, 0 to 255.
 */
function oneLeafRoot(key: Uint8Array, value: Uint8Array): ccc.Hex {
  const baseKey = key.slice();
  baseKey[0] &= 0xfe; // parent path at height 0
  const base = ccc.bytesFrom(ccc.hashCkb(ccc.bytesConcat([0], baseKey, value)));
  const zeroBits = new Uint8Array(32);
  for (let h = 0; h < 256; h++) if (bit(key, h)) zeroBits[h >> 3] |= 1 << (h & 7);
  // 256 merges with zero; the count is one byte and wraps to 0.
  return ccc.hashCkb(ccc.bytesConcat([2], base, zeroBits, [0]));
}

interface Key {
  signer: ccc.SignerCkbPrivateKey;
  /** Identity: flag 0x00 (CKB secp256k1) and blake160 of the public key. */
  auth: Uint8Array;
}
/** The omni_identity of a witness: an identity and its SMT proof. */
type Slot = { auth: Uint8Array; proof: Uint8Array };

const client = new ccc.ClientPublicTestnet();
function newKey(): Key {
  const signer = new ccc.SignerCkbPrivateKey(client, globalThis.crypto.getRandomValues(new Uint8Array(32)));
  return { signer, auth: ccc.bytesConcat([0], ccc.bytesFrom(ccc.hashCkb(signer.publicKey)).slice(0, 20)) };
}

/** OmniLockWitnessLock { signature, omni_identity, preimage: none }. One SmtProofEntry, mask 3. */
function witnessLock(signature: Uint8Array, slot?: Slot): Uint8Array {
  const identity = slot ? table([slot.auth, table([table([Uint8Array.of(3), fixvec(slot.proof)])])]) : new Uint8Array(0);
  return table([fixvec(signature), identity, new Uint8Array(0)]);
}

/**
 * Signs the proof as the lock checks it: the sighash covers the transaction hash and the witness
 * with its whole lock field zeroed, so identity and proofs are filled in after signing.
 */
async function sign(tx: ccc.Transaction, lock: ccc.Script, key: Key, slot?: Slot): Promise<ccc.Transaction> {
  const size = witnessLock(new Uint8Array(65), slot).length;
  tx.witnesses = [ccc.hexFrom(ccc.WitnessArgs.from({ lock: new Uint8Array(size) }).toBytes())];
  const info = (await tx.getSignHashInfo(lock, client))!;
  const signature = ccc.bytesFrom(await key.signer._signMessage(info.message));
  tx.witnesses = [ccc.hexFrom(ccc.WitnessArgs.from({ lock: witnessLock(signature, slot) }).toBytes())];
  return tx;
}

const show = (r: VerifyResult) => (r.ok ? `ACCEPTED, cycles ${r.cycles}` : `REFUSED, ${r.reason}`);

for (const d of DEPLOYMENTS) {
  test(`${d.name}, administrator mode: the admin's key opens the owner's lock, the verifier refuses it`, { skip: NO_VM }, async (t) => {
    const owner = newKey(), admin = newKey(), stranger = newKey();
    const stub = await startStub({ upstream: RPC_URL });
    try {
      // The admin list: one RCRule, whitelist (flags 0x02), whose SMT holds the admin's identity.
      // Its type hash is what the owner's args name. Held under the admin's own lock.
      const rcType = ccc.Script.from({ codeHash: TYPE_ID, hashType: "type", args: ccc.hashCkb(ccc.bytesFrom(`ward omnilock admin ${d.codeHash}`, "utf8")) });
      const rcData = ccc.bytesConcat(u32(0), ccc.bytesFrom(oneLeafRoot(smtKey(admin.auth), WL_VALUE)), [0x02]);
      const adminLock = ccc.Script.from({ codeHash: SECP256K1, hashType: "type", args: admin.auth.slice(1) });
      const rcDep = ccc.CellDep.from({ outPoint: stub.fabricate({ lock: adminLock, type: rcType, data: rcData }, "rc"), depType: "code" });

      // The owner's lock: identity 0x00 + blake160(owner), Omnilock flags 0x01 (admin mode), RC type hash.
      const lock = ccc.Script.from({ codeHash: d.codeHash, hashType: "type", args: ccc.bytesConcat(owner.auth, [0x01], ccc.bytesFrom(rcType.hash())) });
      // The same owner without the admin flag.
      const plainLock = ccc.Script.from({ codeHash: d.codeHash, hashType: "type", args: ccc.bytesConcat(owner.auth, [0x00]) });
      const slot = (k: Key): Slot => ({ auth: k.auth, proof: ONE_LEAF_PROOF });

      let n = 0;
      const build = async (l: ccc.Script, key: Key, s?: Slot, withRc = true) => {
        const text = message({ domain: "dao.example", account: "acct", lock: l, chain: TESTNET_GENESIS, issuedAt: new Date(), nonce: `admin-${n++}` });
        const tx = proofTemplate(l, text);
        tx.cellDeps = [...d.deps.map((x) => ccc.CellDep.from(x)), ...(withRc ? [rcDep] : [])];
        return { lock: l, message: text, tx: await sign(tx, l, key, s) };
      };
      // The lock run directly on the template, the input at u64::MAX, as the verifier runs it.
      const run = async (l: ccc.Script, tx: ccc.Transaction) => runLock!(mockTransaction(tx, proofInput(l), await resolveCellDeps(stub.url, tx.cellDeps)));

      const adminProof = await build(lock, admin, slot(admin));
      const ownerProof = await build(lock, owner);
      const plainProof = await build(plainLock, owner, undefined, false);
      const cases = {
        "admin key, admin identity named": adminProof,
        "owner key, no identity named": ownerProof,
        "owner key, lock without the admin flag": plainProof,
        "stranger key, stranger identity named": await build(lock, stranger, slot(stranger)),
        "stranger key, admin identity named": await build(lock, stranger, slot(admin)),
        "admin key, admin identity named, no RC cell dep": await build(lock, admin, slot(admin), false),
      };
      const runs: Record<string, Awaited<ReturnType<typeof run>>> = {};
      for (const [name, p] of Object.entries(cases)) {
        runs[name] = await run(p.lock, p.tx);
        const r = runs[name];
        t.diagnostic(`lock: ${name}: exit ${r.code}${r.cycles ? `, cycles ${r.cycles}` : ` (${r.output.split("\n").at(-1)})`}`);
      }
      const exit = (name: keyof typeof cases) => runs[name].code;
      // The admin's signature opens the owner's lock.
      assert.equal(exit("admin key, admin identity named"), 0);
      assert.equal(exit("owner key, no identity named"), d.ownerExit);
      if (d.ownerExit === null) assert.match(runs["owner key, no identity named"].output, /write on executable page/);
      assert.equal(exit("owner key, lock without the admin flag"), 0);
      // 59 ERROR_NOT_ON_WHITE_LIST: the identity is not in the admin list's SMT.
      assert.equal(exit("stranger key, stranger identity named"), 59);
      // -31 ERROR_IDENTITY_PUBKEY_BLAKE160_HASH: the signature is checked against the named identity.
      assert.equal(exit("stranger key, admin identity named"), -31);
      // 1 CKB_INDEX_OUT_OF_BOUND: no cell dep or input has the RC type hash. The admin signed this
      // transaction, so the RC cell is the only thing missing.
      assert.equal(exit("admin key, admin identity named, no RC cell dep"), 1);

      // Neither probe opens the admin's witness: an empty witness, and the same witness on
      // another message's template.
      const empty = adminProof.tx.clone();
      empty.witnesses = ["0x"];
      const other = proofTemplate(lock, otherMessage(adminProof.message));
      other.cellDeps = adminProof.tx.cellDeps.map((x) => x.clone());
      other.witnesses = [...adminProof.tx.witnesses];
      const probeA = await run(lock, empty), probeB = await run(lock, other);
      t.diagnostic(`lock: admin proof, probe (a) empty witness: exit ${probeA.code}; probe (b) other message: exit ${probeB.code}`);
      assert.notEqual(probeA.code, 0);
      assert.notEqual(probeB.code, 0);

      // The verifier refuses every proof for a lock with the admin flag, the owner's too, before
      // reading the chain. The same owner without the flag is accepted.
      const opts = (p: { message: string }) => ({ rpcUrl: stub.url, runLock: runLock!, expect: expectFor(p.message, { now: new Date() }) });
      const admitted = await verify(adminProof, opts(adminProof));
      const owned = await verify(ownerProof, opts(ownerProof));
      const plain = await verify(plainProof, opts(plainProof));
      t.diagnostic(`verify: admin proof: ${show(admitted)}; owner proof: ${show(owned)}; owner, no admin flag: ${show(plain)}`);
      assert.equal(!admitted.ok && admitted.reason, "omnilock in administrator mode: an administrator can sign for it");
      assert.equal(!owned.ok && owned.reason, "omnilock in administrator mode: an administrator can sign for it");
      assert.equal(plain.ok, true);
    } finally {
      await stub.close();
    }
  });
}
