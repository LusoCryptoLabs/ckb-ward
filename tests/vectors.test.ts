// Replays the saved testnet proofs through verify(), each with controls that must be refused.
// Needs the testnet RPC and a lock runner (see helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { PROOF_INPUT_CAPACITY, mockTransaction, proofInput, proofTemplate, resolveCellDeps, verify, type MockTransaction, type VerifyResult } from "../src/index.ts";
import { NO_NETWORK, NO_VM, RPC_URL, expectFor, flipWitnessByte, otherMessage, poolAccept, runLock, vectors, type Vector } from "./helpers.ts";

const opts = (message: string) => ({ rpcUrl: RPC_URL, runLock: runLock!, expect: expectFor(message) });
const show = (r: VerifyResult) => (r.ok ? `ACCEPTED, cycles ${r.cycles}` : `REFUSED, ${r.reason}${r.run?.cycles ? `, cycles ${r.run.cycles}` : ""}`);

/** Runs the lock on a transaction directly, skipping the verifier's template check. */
async function runRaw(v: Vector, tx: ccc.Transaction, deps?: MockTransaction["mock_info"]["cell_deps"]) {
  return runLock!(mockTransaction(tx, proofInput(v.lock), deps ?? (await resolveCellDeps(RPC_URL, tx.cellDeps))));
}

for (const v of vectors) {
  const proof = { lock: v.lock, message: v.message, tx: v.tx };

  test(`${v.name}: accepted`, { skip: NO_VM }, async (t) => {
    const r = await verify(proof, opts(v.message));
    t.diagnostic(show(r));
    assert.equal(r.ok, true);
    // The deps it used, for the binding to record: every listed dep, plus dep group members.
    const used = r.ok ? r.cellDeps.map((o) => `${o.txHash}:${o.index}`) : [];
    for (const d of ccc.Transaction.from(v.tx).cellDeps) assert.ok(used.includes(`${d.outPoint.txHash}:${d.outPoint.index}`));
    t.diagnostic(`cell deps used: ${used.length}`);
  });

  test(`${v.name}: control, another message`, { skip: NO_VM }, async (t) => {
    const r = await verify({ ...proof, message: otherMessage(v.message) }, opts(otherMessage(v.message)));
    t.diagnostic(`verifier: ${show(r)}`);
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /not the proof template/);
    // The lock refuses it as well: the same witness on the other message's template.
    const tx = ccc.Transaction.from(v.tx);
    const other = otherMessage(v.message);
    const tpl = proofTemplate(v.lock, other);
    tpl.cellDeps = tx.cellDeps;
    tpl.witnesses = tx.witnesses;
    const raw = await runRaw(v, tpl);
    t.diagnostic(`lock run directly on the other message's template: exit ${raw.code}, cycles ${raw.cycles}`);
    assert.equal(raw.code, v.otherMessageExit);
  });

  test(`${v.name}: the empty witness probe is refused by the lock`, { skip: NO_VM }, async (t) => {
    const tx = ccc.Transaction.from(v.tx);
    tx.witnesses = ["0x"];
    const raw = await runRaw(v, tx);
    t.diagnostic(`lock run directly with an empty witness: exit ${raw.code}`);
    assert.notEqual(raw.code, 0);
  });

  test(`${v.name}: control, one signature bit flipped`, { skip: NO_VM }, async (t) => {
    const r = await verify({ ...proof, tx: flipWitnessByte(v.tx, v.signatureByte) }, opts(v.message));
    t.diagnostic(show(r));
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, `lock exited ${v.signatureFlipExit}`);
  });

  for (const [name, c] of Object.entries(v.controls ?? {})) {
    test(`${v.name}: control, ${name}`, { skip: NO_VM }, async (t) => {
      const r = await verify({ ...proof, tx: c.tx }, opts(v.message));
      t.diagnostic(show(r));
      assert.equal(r.ok, false);
      if (!c.forgedDep) return assert.equal(!r.ok && r.reason, `lock exited ${c.exit}`);
      assert.match(!r.ok ? r.reason : "", /^cell dep 0x[0-9a-f]{64}:\d+ is not live/);
      // Precondition: with the prover's copy of that dep, the lock accepts. So the refusal above
      // is the verifier reading deps from the chain, not the signature failing.
      const tx = ccc.Transaction.from(c.tx);
      const forgedHash = c.forgedDep.cell_dep.out_point.tx_hash;
      const real = await resolveCellDeps(RPC_URL, tx.cellDeps.filter((d) => d.outPoint.txHash !== forgedHash));
      const raw = await runRaw(v, tx, [...real, c.forgedDep]);
      t.diagnostic(`same proof, prover's copy of the dep, lock run directly: exit ${raw.code}, cycles ${raw.cycles}`);
      assert.equal(raw.code, 0);
    });
  }

  test(`${v.name}: the node refuses the signed proof`, { skip: NO_NETWORK }, async (t) => {
    const e = await poolAccept(v.tx);
    t.diagnostic(e);
    assert.match(e, /Unknown\(OutPoint\(0x[0-9a-f]{64}ffffffff\)\)/);
  });
}

test("anyone-can-pay: the path without a signature is real, and only the template closes it", { skip: NO_VM }, async (t) => {
  // Precondition of controls.noSignature: the refusal (exit -44, no output to pair the input with)
  // must come from the template, not from a lock that never opens without a signature. The same
  // empty witness on a transaction the prover built, whose only output is under the same lock and
  // receives the input's whole capacity, opens the lock. The verifier refuses that transaction at
  // the template check, before any lock runs.
  const v = vectors.find((x) => x.file === "anyone-can-pay.json")!;
  const c = v.controls!.noSignature;
  const tx = ccc.Transaction.from(c.tx).clone();
  assert.deepEqual(tx.witnesses, ["0x"]);
  tx.outputs[0] = ccc.CellOutput.from({ capacity: PROOF_INPUT_CAPACITY, lock: v.lock });
  tx.outputsData[0] = "0x";
  const raw = await runRaw(v, tx);
  t.diagnostic(`no signature, an output under the same lock, lock run directly: exit ${raw.code}, cycles ${raw.cycles}`);
  assert.equal(raw.code, 0);
  const r = await verify({ lock: v.lock, message: v.message, tx }, { ...opts(v.message), runLock: async () => assert.fail("no lock run") });
  assert.match(!r.ok ? r.reason : "", /not the proof template/);
});

test("a platform pinned to mainnet, given a testnet node, refuses before reading cells", { skip: NO_NETWORK }, async () => {
  const v = vectors.find((x) => x.file === "secp256k1.json")!;
  const mainnet = "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5";
  const message = v.message.replace(/\nChain: 0x[0-9a-f]{64}/, `\nChain: ${mainnet}`);
  // The template of the mainnet message, so every free check passes; the signature does not matter.
  const tx = proofTemplate(v.lock, message);
  tx.cellDeps = ccc.Transaction.from(v.tx).cellDeps;
  tx.witnesses = ["0x"];
  const r = await verify({ lock: v.lock, message, tx }, { ...opts(message), runLock: async () => assert.fail("no lock run") });
  assert.deepEqual(r, { ok: false, reason: "the node is on another chain", run: undefined });
});
