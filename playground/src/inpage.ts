// A proof checked inside this page: Ward's verifier from the browser entry, with the lock run by
// ckb-vm-js (CKB's transaction verifier and CKB-VM in WebAssembly). The page reads the chain from a
// public RPC; the proof is not sent to the server.
import { ccc } from "@ckb-ccc/connector-react";
import { ckbVmJs, message, proofTemplate, verify, type CkbVmJsVerifier, type RunLock } from "../../src/browser.ts";
import type { Net } from "./lib";

/** Genesis hashes as the server has them in its config: never taken from the proof or the node. */
export const GENESIS: Record<Net, string> = {
  testnet: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  mainnet: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
};
export const RPC: Record<Net, string> = { testnet: "https://testnet.ckb.dev/rpc", mainnet: "https://mainnet.ckb.dev/rpc" };
const MAX_AGE_SECONDS = 600;

let verifier: Promise<CkbVmJsVerifier> | undefined;
const runLocks: Partial<Record<Net, RunLock>> = {};

/** Loads the WebAssembly verifier (about 1 MB, 375 kB compressed) once, ahead of the first check. */
export function loadVerifier(): Promise<CkbVmJsVerifier> {
  const v = (verifier ??= import("ckb-vm-js").then((m) => m.createVerifier()));
  v.catch(() => (verifier = undefined));
  return v;
}

/** A fresh request: the message and the template, built here. */
export function request(n: Net, domain: string, account: string, lock: ccc.Script) {
  const nonce = ccc.hexFrom(crypto.getRandomValues(new Uint8Array(16))).slice(2);
  const text = message({ domain, account, lock, chain: GENESIS[n], issuedAt: new Date().toISOString(), nonce });
  return { nonce, message: text, template: proofTemplate(lock, text) };
}

export type InPage =
  | { ok: true; ms: number; cycles: string; cellDeps: { txHash: string; index: number }[] }
  | { ok: false; ms: number; reason: string };

/** Ward's checks, in this page, against the message this page issued. */
export async function checkHere(n: Net, domain: string, account: string, lock: ccc.Script, req: { nonce: string; message: string }, tx: ccc.Transaction): Promise<InPage> {
  runLocks[n] ??= ckbVmJs({ verifier: await loadVerifier(), rpcUrl: RPC[n] });
  const t0 = performance.now();
  const r = await verify(
    { lock, message: req.message, tx },
    { rpcUrl: RPC[n], runLock: runLocks[n]!, expect: { message: req.message, domain, account, nonce: req.nonce, chain: GENESIS[n], maxAgeSeconds: MAX_AGE_SECONDS } },
  );
  const ms = Math.round(performance.now() - t0);
  if (!r.ok) return { ok: false, ms, reason: r.reason };
  return { ok: true, ms, cycles: String(r.cycles), cellDeps: r.cellDeps.map((o) => ({ txHash: o.txHash, index: Number(o.index) })) };
}
