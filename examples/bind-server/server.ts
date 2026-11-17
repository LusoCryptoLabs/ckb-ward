// A small service that binds any CKB lock to an account with a Ward proof, and reads its Nervos DAO
// weight at a snapshot block: what a voting platform adds next to a Neuron message binding.
// Outside this repository, import from "ckb-ward" instead of "../../src/index.ts".
//
//   NETWORK=testnet DOMAIN=vote.example PORT=8090 node examples/bind-server/server.ts
//
// Routes (JSON):
//   POST /bind/request  { account, address }  -> { nonce, message, template }
//   POST /bind/verify   { nonce, tx }         -> { ok, account, address, lockHash, cycles, cellDeps } | { ok: false, reason }
//   GET  /weight?address=...&block=...        -> { weight, deposits, withdrawing }
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { ccc } from "@ckb-ccc/core";
import { ckbVmJs, daoWeightAt, message, proofTemplate, tipEpoch, verify, wardVm, type CkbVmJsVerifier, type RunLock } from "../../src/index.ts";

export type Network = "testnet" | "mainnet";

/** From the platform's own config, never from a proof or a node. */
const GENESIS: Record<Network, ccc.Hex> = {
  testnet: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  mainnet: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
};
const RPC: Record<Network, string> = { testnet: "https://testnet.ckb.dev/rpc", mainnet: "https://mainnet.ckb.dev/rpc" };
/** A request is good for 10 minutes and for one attempt: Ward claims the nonce before it runs the lock. */
const MAX_AGE_SECONDS = 600;

export interface BindServerOptions {
  network: Network;
  /** The platform's host, as the wallet will show it. */
  domain: string;
  rpcUrl?: string;
  /** How the lock runs. Default: ckb-vm-js, which must be installed next to ckb-ward. */
  runLock?: RunLock;
}

interface Pending {
  account: string;
  address: string;
  lock: ccc.Script;
  message: string;
  issuedAt: number;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The lock runner from the environment: RUNNER=ward-vm (WARD_VM is its path) or ckb-vm-js. */
export async function runnerFromEnv(network: Network, rpcUrl: string): Promise<RunLock> {
  if (process.env.RUNNER === "ward-vm") return wardVm({ command: process.env.WARD_VM, chain: network, epoch: () => tipEpoch(rpcUrl) });
  const name = "ckb-vm-js";
  const vmjs = (await import(name).catch(() => {
    throw new Error("ckb-vm-js is not installed: install it, or set RUNNER=ward-vm and WARD_VM");
  })) as { createVerifier(options?: { wasm?: Uint8Array }): Promise<CkbVmJsVerifier> };
  // In Node, ckb-vm-js cannot fetch its .wasm from a file URL, so read it and pass the bytes.
  const wasm = await readFile(new URL(import.meta.resolve(`${name}/wasm`)));
  return ckbVmJs({ verifier: await vmjs.createVerifier({ wasm }), rpcUrl });
}

export async function createBindServer(options: BindServerOptions): Promise<Server> {
  const { network, domain } = options;
  const rpcUrl = options.rpcUrl ?? RPC[network];
  const runLock = options.runLock ?? (await runnerFromEnv(network, rpcUrl));
  const client = network === "testnet" ? new ccc.ClientPublicTestnet({ url: rpcUrl }) : new ccc.ClientPublicMainnet({ url: rpcUrl });
  // In memory for the example; a platform keeps these in its database.
  const pending = new Map<string, Pending>();

  async function request(body: any) {
    const account = body?.account;
    const address = body?.address;
    if (typeof account !== "string" || !account) throw new HttpError(400, "account missing");
    if (typeof address !== "string" || !address) throw new HttpError(400, "address missing");
    let lock: ccc.Script;
    try {
      lock = (await ccc.Address.fromString(address, client)).script;
    } catch {
      throw new HttpError(400, `not a ${network} address`);
    }
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = Date.now();
    const text = message({ domain, account, lock, chain: GENESIS[network], issuedAt: new Date(issuedAt).toISOString(), nonce });
    pending.set(nonce, { account, address, lock, message: text, issuedAt });
    for (const [n, p] of pending) if (Date.now() - p.issuedAt > MAX_AGE_SECONDS * 1000) pending.delete(n);
    return { nonce, message: text, template: JSON.parse(proofTemplate(lock, text).stringify()) };
  }

  async function check(body: any) {
    const p = typeof body?.nonce === "string" ? pending.get(body.nonce) : undefined;
    if (!p) throw new HttpError(404, "unknown or used nonce");
    const r = await verify(
      { lock: p.lock, message: p.message, tx: body.tx as ccc.TransactionLike },
      {
        rpcUrl,
        runLock,
        expect: { message: p.message, domain, account: p.account, nonce: body.nonce, chain: GENESIS[network], maxAgeSeconds: MAX_AGE_SECONDS },
        // One attempt per request, accepted or refused, also under concurrent posts.
        claimNonce: () => pending.delete(body.nonce),
      },
    );
    if (!r.ok) return { status: 400, json: { ok: false, reason: r.reason } };
    return {
      status: 200,
      json: { ok: true, account: p.account, address: p.address, lockHash: p.lock.hash(), cycles: String(r.cycles), cellDeps: r.cellDeps.map((o) => ({ txHash: o.txHash, index: Number(o.index) })) },
    };
  }

  async function weight(url: URL) {
    const address = url.searchParams.get("address");
    const block = url.searchParams.get("block");
    if (!address || !block || !/^\d+$/.test(block)) throw new HttpError(400, "address and block are required");
    const lock = (await ccc.Address.fromString(address, client).catch(() => {
      throw new HttpError(400, `not a ${network} address`);
    })).script;
    const w = await daoWeightAt(rpcUrl, lock, BigInt(block));
    return { weight: String(w.weight), deposits: w.deposits.length, withdrawing: w.withdrawing.length };
  }

  const send = (res: ServerResponse, status: number, json: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(json));
  };
  const read = async (req: IncomingMessage) => {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 256_000) throw new HttpError(413, "body too large");
    }
    try {
      return JSON.parse(raw || "{}");
    } catch {
      throw new HttpError(400, "body is not JSON");
    }
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "POST" && url.pathname === "/bind/request") return send(res, 200, await request(await read(req)));
      if (req.method === "POST" && url.pathname === "/bind/verify") {
        const r = await check(await read(req));
        return send(res, r.status, r.json);
      }
      if (req.method === "GET" && url.pathname === "/weight") return send(res, 200, await weight(url));
      send(res, 404, { reason: "not found" });
    } catch (e) {
      // A node that does not answer is "could not verify", not "refused".
      send(res, e instanceof HttpError ? e.status : 502, { ok: false, reason: (e as Error).message });
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const network = (process.env.NETWORK ?? "testnet") as Network;
  if (network !== "testnet" && network !== "mainnet") throw new Error("NETWORK is testnet or mainnet");
  const domain = process.env.DOMAIN;
  if (!domain) throw new Error("DOMAIN is required: the host the wallet shows");
  const port = Number(process.env.PORT ?? 8090);
  (await createBindServer({ network, domain, rpcUrl: process.env.RPC_URL })).listen(port, () => console.log(`bind server on :${port}, ${network}, domain ${domain}`));
}
