// The Ward playground: a gallery of runnable examples, the way app.ckbccc.com is for CCC. Each
// example maps to one part of the library. A wallet connects, signs a proof, and the server runs
// the lock in CKB-VM to check it. Nothing is ever sent to the chain, on either network, so the
// testnet/mainnet switch costs nothing: a proof transaction can never land.
//
//   DOMAIN=localhost:8080 WARD_VM=/path/to/ward-vm node playground/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ccc } from "@ckb-ccc/core";
import { daoWeightAt, jsonRpc, message, proofTemplate, tipEpoch, verify, wardVm } from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DOMAIN = process.env.DOMAIN ?? "ward-play.lusocryptolabs.com";
const DATA_DIR = process.env.DATA_DIR ?? "playground/data";
const STATIC_DIR = fileURLToPath(new URL("./dist/", import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_AGE_SECONDS = 600;
const SECURE_COOKIE = !/^localhost(:\d+)?$/.test(DOMAIN);

type Net = "testnet" | "mainnet";
const net = (n: unknown): Net => (n === "mainnet" ? "mainnet" : "testnet");

/** Genesis hashes from config (never from the proof or the node), and the RPC of each network. */
const GENESIS: Record<Net, string> = {
  testnet: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  mainnet: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
};
const RPC: Record<Net, string> = {
  testnet: process.env.RPC_URL ?? "https://testnet.ckb.dev/rpc",
  mainnet: process.env.RPC_URL_MAINNET ?? "https://mainnet.ckb.dev/rpc",
};

const vmCommand = process.env.WARD_VM ?? "ward-vm";
const vmWsl = process.env.WARD_VM_WSL ? { distro: process.env.WARD_VM_WSL } : undefined;
const runLocks: Record<Net, ReturnType<typeof wardVm>> = {
  testnet: wardVm({ command: vmCommand, wsl: vmWsl, chain: "testnet", epoch: () => tipEpoch(RPC.testnet) }),
  mainnet: wardVm({ command: vmCommand, wsl: vmWsl, chain: "mainnet", epoch: () => tipEpoch(RPC.mainnet) }),
};
const rpcs: Record<Net, ReturnType<typeof jsonRpc>> = { testnet: jsonRpc(RPC.testnet), mainnet: jsonRpc(RPC.mainnet) };
const tip = async (n: Net) => BigInt((await rpcs[n]("get_tip_header", [])).number);

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "ward-play.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, lock_hash TEXT NOT NULL, lock TEXT NOT NULL, message TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'testnet', issued_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, lock_hash TEXT NOT NULL, network TEXT NOT NULL DEFAULT 'testnet', created_at TEXT NOT NULL);
`);
// Older databases predate the network column; add it in place.
for (const t of ["nonces", "sessions"]) {
  try {
    db.exec(`ALTER TABLE ${t} ADD COLUMN network TEXT NOT NULL DEFAULT 'testnet'`);
  } catch {
    /* already there */
  }
}

// --- http helpers ------------------------------------------------------------------------------

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw new HttpError(413, "request too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "not JSON");
  }
}

function cookieSession(req: IncomingMessage): { account: string; lockHash: string; network: Net } | undefined {
  const m = /(?:^|;\s*)ward_play=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
  if (!m) return undefined;
  const row = db.prepare("SELECT account, lock_hash, network FROM sessions WHERE token = ?").get(m[1]) as any;
  return row ? { account: row.account, lockHash: row.lock_hash, network: net(row.network) } : undefined;
}

const hits = new Map<string, number[]>();
function limit(req: IncomingMessage, route: string, perMinute: number) {
  const ip = (req.headers["x-real-ip"] as string) ?? req.socket.remoteAddress ?? "?";
  const key = `${route} ${ip}`;
  const now = Date.now();
  if (hits.size > 50_000) hits.clear();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= perMinute) throw new HttpError(429, "too many requests, try again in a minute");
  recent.push(now);
  hits.set(key, recent);
}

function send(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".woff2": "font/woff2" };
function serveStatic(req: IncomingMessage, res: ServerResponse) {
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^([/\\])+/, "");
  let file = join(STATIC_DIR, path);
  if (!file.startsWith(STATIC_DIR) || !existsSync(file) || path === "") file = join(STATIC_DIR, "index.html");
  const type = TYPES[extname(file)] ?? "application/octet-stream";
  res.writeHead(200, { "content-type": type, "cache-control": file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable" });
  res.end(readFileSync(file));
}

// --- proof verifying ---------------------------------------------------------------------------

/** Issue a message and its template for a lock on one network. The account is the caller's own choice (the demos use the address). */
async function issue(account: string, lockLike: ccc.ScriptLike, network: Net) {
  const script = ccc.Script.from(lockLike);
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = new Date().toISOString();
  let text: string;
  try {
    text = message({ domain: DOMAIN, account, lock: script, chain: GENESIS[network], issuedAt, nonce });
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  db.prepare("INSERT INTO nonces (nonce, account, lock_hash, lock, message, network, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    nonce, account, script.hash(), JSON.stringify({ codeHash: script.codeHash, hashType: script.hashType, args: script.args }), text, network, issuedAt,
  );
  return { nonce, message: text, template: JSON.parse(proofTemplate(script, text).stringify()) };
}

/** Run verify for a stored nonce against a signed proof, on the network it was issued for. */
async function checkProof(nonce: string, tx: unknown) {
  const row = db.prepare("SELECT * FROM nonces WHERE nonce = ?").get(String(nonce)) as any;
  if (!row) throw new HttpError(404, "unknown nonce");
  const network = net(row.network);
  const r = await verify(
    { lock: JSON.parse(row.lock), message: row.message, tx: tx as ccc.TransactionLike },
    {
      rpcUrl: RPC[network],
      runLock: runLocks[network],
      expect: { message: row.message, domain: DOMAIN, account: row.account, nonce: row.nonce, chain: GENESIS[network], maxAgeSeconds: MAX_AGE_SECONDS },
      claimNonce: () => db.prepare("UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(new Date().toISOString(), row.nonce).changes === 1,
    },
  );
  return { row, network, result: r };
}

function serialProof(r: Awaited<ReturnType<typeof verify>>) {
  if (!r.ok) return { ok: false as const, reason: r.reason };
  return { ok: true as const, fields: r.fields, cycles: r.cycles, cellDeps: r.cellDeps.map((o) => ({ txHash: o.txHash, index: Number(o.index) })) };
}

// --- routes ------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const session = cookieSession(req);

  if (req.method === "GET" && url.pathname === "/api/config") {
    return send(res, 200, { domain: DOMAIN, networks: ["testnet", "mainnet"], genesis: GENESIS });
  }

  if (req.method === "GET" && url.pathname === "/api/me") {
    limit(req, "me", 60);
    return send(res, 200, { account: session?.account ?? null, lockHash: session?.lockHash ?? null, network: session?.network ?? null });
  }

  if (req.method === "POST" && url.pathname === "/api/signout") {
    limit(req, "signout", 30);
    const m = /(?:^|;\s*)ward_play=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
    if (m) db.prepare("DELETE FROM sessions WHERE token = ?").run(m[1]);
    return send(res, 200, { ok: true }, { "set-cookie": `ward_play=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${SECURE_COOKIE ? "; Secure" : ""}` });
  }

  if (req.method === "POST" && url.pathname === "/api/nonce") {
    limit(req, "nonce", 30);
    const { account, lock, network } = await body(req);
    if (typeof account !== "string" || !account) throw new HttpError(400, "account missing");
    return send(res, 200, await issue(account, lock, net(network)));
  }

  if (req.method === "POST" && url.pathname === "/api/verify") {
    limit(req, "verify", 20);
    const { nonce, tx } = await body(req);
    const { result } = await checkProof(nonce, tx);
    return send(res, result.ok ? 200 : 400, serialProof(result));
  }

  if (req.method === "POST" && url.pathname === "/api/signin") {
    limit(req, "signin", 20);
    const { nonce, tx } = await body(req);
    const { row, network, result } = await checkProof(nonce, tx);
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions (token, account, lock_hash, network, created_at) VALUES (?, ?, ?, ?, ?)").run(token, row.account, row.lock_hash, network, new Date().toISOString());
    return send(res, 200, { ...serialProof(result), account: row.account, lockHash: row.lock_hash, network }, {
      "set-cookie": `ward_play=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${SECURE_COOKIE ? "; Secure" : ""}`,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/weight") {
    limit(req, "weight", 20);
    const { lock, network } = await body(req);
    const n = net(network);
    const script = ccc.Script.from(lock);
    const at = await tip(n);
    const w = await daoWeightAt(RPC[n], script, at);
    return send(res, 200, { block: at, weight: w.weight, deposits: w.deposits.length, withdrawing: w.withdrawing.length });
  }

  if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(req, res);
  throw new HttpError(404, "not found");
}

createServer(async (req, res) => {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
  res.setHeader("content-security-policy", "frame-ancestors 'none'");
  try {
    await route(req, res);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    const node = !(e instanceof HttpError) && /timeout|aborted|fetch failed|get_|ECONN|ETIMEDOUT/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`);
    const code = node ? 503 : status;
    if (code >= 500) console.error(new Date().toISOString(), req.method, req.url, code, e);
    if (!res.headersSent) send(res, code, { ok: false, reason: code === 503 ? "the node did not answer in time; try again" : status === 500 ? "the server could not answer; try again" : (e as Error).message });
  }
}).listen(PORT, () => console.log(`[ward-play] ${DOMAIN} on :${PORT}`));
