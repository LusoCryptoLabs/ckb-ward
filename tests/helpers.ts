import { readdirSync, readFileSync } from "node:fs";
import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";
import { ckbDebugger, parseMessage, tipEpoch, wardVm, type Expect, type RunLock } from "../src/index.ts";

export interface Control {
  about: string;
  /** Exit code of the lock, when the lock is what refuses it. */
  exit?: number;
  tx: ccc.TransactionLike;
  forgedDep?: any;
}

export interface Vector {
  file: string;
  name: string;
  about: string;
  lock: ccc.ScriptLike;
  message: string;
  tx: ccc.TransactionLike;
  /** Offset in witness 0 of a byte inside the signature. */
  signatureByte: number;
  /** Exit code of the lock for the same witness on another message's template. */
  otherMessageExit: number;
  /** Exit code of the lock with one bit flipped at signatureByte. */
  signatureFlipExit: number;
  controls?: Record<string, Control>;
}

const DIR = new URL("./vectors/", import.meta.url);
export const vectors: Vector[] = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, ...JSON.parse(readFileSync(new URL(f, DIR), "utf8")) }));

/** Testnet RPC. CKB_WARD_OFFLINE=1 skips every test that needs it. */
export const RPC_URL = process.env.CKB_RPC_URL ?? "https://testnet.ckb.dev/rpc";
export const NO_NETWORK = process.env.CKB_WARD_OFFLINE === "1" ? "CKB_WARD_OFFLINE=1" : false;

/**
 * The lock runner. Tests that run a lock are skipped unless CKB_DEBUGGER (the executable) or
 * CKB_DEBUGGER_WSL (a WSL distro holding it) is set. Example on Windows:
 * CKB_DEBUGGER_WSL=ChiralSP1 CKB_DEBUGGER=/root/.cargo/bin/ckb-debugger npm test
 */
const command = process.env.CKB_DEBUGGER;
const distro = process.env.CKB_DEBUGGER_WSL;
export const debuggerRunLock: RunLock | undefined =
  command || distro ? ckbDebugger({ command, wsl: distro ? { distro, user: process.env.CKB_DEBUGGER_WSL_USER } : undefined }) : undefined;

/**
 * ward-vm (vm/ in this repository): WARD_VM (the executable) or WARD_VM_WSL (a WSL distro holding
 * it). It runs under testnet's consensus at the tip's epoch, read from the RPC; offline, at
 * OFFLINE_EPOCH, a testnet epoch of 2026-11-05 (after the 2023 hardfork, like the tip).
 */
export const OFFLINE_EPOCH = 14137n;
const vmCommand = process.env.WARD_VM;
const vmDistro = process.env.WARD_VM_WSL;
export const wardVmRunLock: RunLock | undefined =
  vmCommand || vmDistro
    ? wardVm({
        command: vmCommand,
        wsl: vmDistro ? { distro: vmDistro, user: process.env.WARD_VM_WSL_USER } : undefined,
        chain: "testnet",
        epoch: process.env.CKB_WARD_OFFLINE === "1" ? OFFLINE_EPOCH : () => tipEpoch(RPC_URL),
      })
    : undefined;

/** The runner the tests use: ckb-debugger when it is set, else ward-vm. */
export const runLock: RunLock | undefined = debuggerRunLock ?? wardVmRunLock;
export const NO_DEBUGGER = runLock ? false : "set CKB_DEBUGGER, CKB_DEBUGGER_WSL, WARD_VM or WARD_VM_WSL to run locks";
export const NO_VM = NO_NETWORK || NO_DEBUGGER;
export const NO_BOTH = debuggerRunLock && wardVmRunLock ? false : "set both a ckb-debugger and a ward-vm runner to compare them";

/** The same message with one more character in the nonce. */
export const otherMessage = (message: string) => message.replace(/\nNonce: (.*)$/, "\nNonce: $1x");

/** A copy of the transaction with one bit flipped in witness 0 at the given byte offset. */
export function flipWitnessByte(txLike: ccc.TransactionLike, offset: number): ccc.Transaction {
  const tx = ccc.Transaction.from(txLike).clone();
  const w = ccc.bytesFrom(tx.witnesses[0]).slice();
  w[offset] ^= 0x01;
  tx.witnesses[0] = ccc.hexFrom(w);
  return tx;
}

/** test_tx_pool_accept: the node's full check, nothing added to the pool. Returns the error text. */
export async function poolAccept(txLike: ccc.TransactionLike): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "test_tx_pool_accept", params: [JsonRpcTransformers.transactionFrom(ccc.Transaction.from(txLike)), "passthrough"] }),
  });
  const body = await res.json();
  return body.error ? String(body.error.message) : `ACCEPTED ${JSON.stringify(body.result)}`;
}

/**
 * What a platform that issued `message` passes as `expect`: the message as stored, its own domain
 * and chain, the account and nonce, a 10 minute window, and a clock one minute after issue.
 */
export function expectFor(message: string, overrides: Partial<Expect> = {}): Expect {
  const f = parseMessage(message);
  return { message, domain: f.domain, account: f.account, nonce: f.nonce, chain: f.chain, maxAgeSeconds: 600, now: new Date(Date.parse(f.issuedAt) + 60_000), ...overrides };
}
