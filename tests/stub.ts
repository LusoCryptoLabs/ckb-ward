// A local JSON RPC node for verify(). It answers get_live_cell itself for cells registered with
// fabricate() (cells an attacker could deploy, which these tests do not deploy: nothing is sent to
// any chain), and forwards every other call to `upstream` when one is given. Without an upstream it
// answers the genesis hash and "unknown" for any other cell, so tests run offline. It counts calls
// per method, so a test can show how much chain work a proof costs before it is refused.
import http from "node:http";
import { ccc } from "@ckb-ccc/core";
import { JsonRpcTransformers } from "@ckb-ccc/core/advanced";

export const TESTNET_GENESIS = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";

export interface StubOptions {
  /** Node to forward unknown calls to. */
  upstream?: string;
  /** Genesis hash to answer for get_block_hash(0). Default: testnet's, or the upstream's. */
  genesis?: string;
  /** Wait this long before each answer. */
  delayMs?: number;
}

export interface Stub {
  url: string;
  counts: Record<string, number>;
  resetCounts(): void;
  /** Registers a live cell at a made-up out point and returns the out point. */
  fabricate(cell: { capacity?: bigint; lock: ccc.ScriptLike; type?: ccc.ScriptLike; data?: ccc.HexLike }, tag: string): ccc.OutPoint;
  close(): Promise<void>;
}

async function forward(url: string, method: string, params: unknown) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }) });
  return res.json();
}

export async function startStub(options: StubOptions = {}): Promise<Stub> {
  const cells = new Map<string, unknown>();
  const counts: Record<string, number> = {};
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    counts[msg.method] = (counts[msg.method] ?? 0) + 1;
    if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
    let answer: unknown;
    const key = msg.method === "get_live_cell" ? `${msg.params[0].tx_hash}:${Number(msg.params[0].index)}` : "";
    if (msg.method === "get_block_hash" && msg.params[0] === "0x0" && (options.genesis || !options.upstream)) {
      answer = { result: options.genesis ?? TESTNET_GENESIS };
    } else if (cells.has(key)) {
      answer = { result: cells.get(key) };
    } else if (options.upstream) {
      const r = (await forward(options.upstream, msg.method, msg.params)) as { result?: unknown; error?: unknown };
      answer = r.error ? { error: r.error } : { result: r.result };
    } else if (msg.method === "get_live_cell") {
      answer = { result: { cell: null, status: "unknown" } };
    } else {
      answer = { error: { code: -32601, message: `stub has no ${msg.method}` } };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: msg.id, jsonrpc: "2.0", ...(answer as object) }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address() as { port: number };
  let seq = 0;
  return {
    url: `http://127.0.0.1:${address.port}/`,
    counts,
    resetCounts: () => {
      for (const k of Object.keys(counts)) delete counts[k];
    },
    fabricate({ capacity = 1000n * 100000000n, lock, type, data = "0x" }, tag) {
      const txHash = ccc.hashCkb(ccc.bytesFrom(`fabricated ${tag} ${seq++}`, "utf8"));
      const hex = ccc.hexFrom(data);
      cells.set(`${txHash}:0`, {
        status: "live",
        cell: {
          output: { capacity: ccc.numToHex(capacity), lock: JsonRpcTransformers.scriptFrom(lock), type: type ? JsonRpcTransformers.scriptFrom(type) : null },
          data: { content: hex, hash: ccc.hashCkb(hex) },
        },
      });
      return ccc.OutPoint.from({ txHash, index: 0 });
    },
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
