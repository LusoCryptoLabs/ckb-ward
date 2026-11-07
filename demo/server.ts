// The Ward demo: a reference platform on testnet that follows the platform rules of the spec
// (section 9). A wallet proves its lock, the platform binds the lock to an account, and the
// Nervos DAO deposits under bound locks count in a test vote at a snapshot block.
//
// Votes run in cycles: binding is open for the first part of each cycle, then a vote opens with
// its snapshot at the tip and binding is frozen until it closes (rule 7).
//
//   DOMAIN=localhost:8080 WARD_VM=/path/to/ward-vm node demo/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { ccc } from "@ckb-ccc/core";
import { daoWeightAt, depsLiveAt, jsonRpc, message, proofTemplate, tipEpoch, verify, wardVm } from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DOMAIN = process.env.DOMAIN ?? "ward-demo.lusocryptolabs.com";
const RPC_URL = process.env.RPC_URL ?? "https://testnet.ckb.dev/rpc";
/** Testnet's genesis hash, from config (rule 5), never from the proof or the node. */
const CHAIN = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const DATA_DIR = process.env.DATA_DIR ?? "demo/data";
const STATIC_DIR = fileURLToPath(new URL("./dist/", import.meta.url));
const CYCLE_MS = Number(process.env.CYCLE_MS ?? 15 * 60_000);
const BIND_MS = Number(process.env.BIND_MS ?? 10 * 60_000);
/** Rule 6: a binding moved to another account carries no weight for this long. 72 hours in the spec's example; short here so a visitor can see it end. */
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 20 * 60_000);
/** Rule 10. */
const MAX_BODY = 64 * 1024;
const MAX_AGE_SECONDS = 600;
const SECURE_COOKIE = !/^localhost(:\d+)?$/.test(DOMAIN);
const QUESTION = "Should Nervos DAO deposits held in any wallet count in community votes?";
const OPTIONS = ["Yes", "No"];

const runLock = wardVm({
  command: process.env.WARD_VM ?? "ward-vm",
  wsl: process.env.WARD_VM_WSL ? { distro: process.env.WARD_VM_WSL } : undefined,
  chain: "testnet",
  epoch: () => tipEpoch(RPC_URL),
});
const rpc = jsonRpc(RPC_URL);
const tip = async () => BigInt((await rpc("get_tip_header", [])).number);

mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, "ward-demo.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, account TEXT NOT NULL, lock_hash TEXT NOT NULL, lock TEXT NOT NULL, message TEXT NOT NULL, issued_at TEXT NOT NULL, used_at TEXT);
  CREATE TABLE IF NOT EXISTS bindings (lock_hash TEXT PRIMARY KEY, lock TEXT NOT NULL, account TEXT NOT NULL, bound_at TEXT NOT NULL, bound_block INTEGER NOT NULL, moved_from TEXT, cell_deps TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, lock_hash TEXT NOT NULL, account TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, block INTEGER);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS polls (id INTEGER PRIMARY KEY, snapshot_block INTEGER NOT NULL, opened_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS votes (poll_id INTEGER NOT NULL, account TEXT NOT NULL, choice TEXT NOT NULL, weight TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (poll_id, account));
`);

// --- cycles and polls -------------------------------------------------------------------------

function phaseAt(now = Date.now()) {
  const id = Math.floor(now / CYCLE_MS);
  const start = id * CYCLE_MS;
  const voting = now - start >= BIND_MS;
  return { id, voting, voteOpensAt: start + BIND_MS, closesAt: start + CYCLE_MS };
}

/** The poll of the current cycle, opened (snapshot at the tip) the first time the vote phase is seen. */
async function currentPoll() {
  const p = phaseAt();
  if (!p.voting) return undefined;
  const row = db.prepare("SELECT * FROM polls WHERE id = ?").get(p.id) as any;
  if (row) return row;
  const block = await retry(tip);
  db.prepare("INSERT OR IGNORE INTO polls (id, snapshot_block, opened_at) VALUES (?, ?, ?)").run(p.id, Number(block), new Date().toISOString());
  return db.prepare("SELECT * FROM polls WHERE id = ?").get(p.id) as any;
}

function tally(pollId: number) {
  const votes = db.prepare("SELECT account, choice, weight, detail FROM votes WHERE poll_id = ? ORDER BY at").all(pollId) as any[];
  const totals = Object.fromEntries(OPTIONS.map((o) => [o, { weight: 0n, accounts: 0 }]));
  for (const v of votes) {
    totals[v.choice].weight += BigInt(v.weight);
    totals[v.choice].accounts += 1;
  }
  return {
    totals: Object.fromEntries(Object.entries(totals).map(([o, t]) => [o, { weight: t.weight.toString(), accounts: t.accounts }])),
    votes: votes.map((v) => ({ account: v.account, choice: v.choice, weight: v.weight, locks: JSON.parse(v.detail) })),
  };
}

const weighed = new Map<string, { live: boolean; weight: bigint; deposits: number; withdrawing: number }>();

/** A chain read that a slow moment of the public node should not fail: three tries, a pause between. */
async function retry<T>(read: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await read();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

/** Rule 8: what each of an account's locks weighs in a poll, and why a lock does not count. */
async function weighAccount(account: string, poll: { snapshot_block: number; opened_at: string }) {
  const bindings = db.prepare("SELECT * FROM bindings WHERE account = ?").all(account) as any[];
  const snapshot = BigInt(poll.snapshot_block);
  let total = 0n;
  const locks = [];
  for (const b of bindings) {
    const item: { lockHash: string; weight: string; counted: boolean; reason: string } = { lockHash: b.lock_hash, weight: "0", counted: false, reason: "" };
    if (BigInt(b.bound_block) >= snapshot) item.reason = "bound at or after the snapshot block";
    else if (b.moved_from && Date.parse(poll.opened_at) - Date.parse(b.bound_at) < COOLDOWN_MS) item.reason = `moved from ${b.moved_from}, still in its cooldown`;
    else {
      // What a lock weighs at a snapshot does not change: read once, kept for the vote.
      const key = `${poll.snapshot_block} ${b.lock_hash} ${b.cell_deps}`;
      let found = weighed.get(key);
      if (!found) {
        found = await retry(async () => {
          if (!(await depsLiveAt(RPC_URL, JSON.parse(b.cell_deps), snapshot)).live) return { live: false, weight: 0n, deposits: 0, withdrawing: 0 };
          const w = await daoWeightAt(RPC_URL, JSON.parse(b.lock), snapshot);
          return { live: true, weight: w.weight, deposits: w.deposits.length, withdrawing: w.withdrawing.length };
        });
        if (weighed.size > 10_000) weighed.clear();
        weighed.set(key, found);
      }
      if (!found.live) item.reason = "a cell its proof ran with was not live at the snapshot; prove again";
      else {
        item.weight = found.weight.toString();
        item.counted = true;
        item.reason = `${found.deposits} deposit(s) live at the snapshot${found.withdrawing ? `, ${found.withdrawing} withdrawing cell(s) not counted` : ""}`;
        total += found.weight;
      }
    }
    locks.push(item);
  }
  return { total, locks };
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

function cookieAccount(req: IncomingMessage): string | undefined {
  const m = /(?:^|;\s*)ward_demo=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
  if (!m) return undefined;
  return (db.prepare("SELECT account FROM sessions WHERE token = ?").get(m[1]) as any)?.account;
}

function owner(account: string): boolean {
  return !!db.prepare("SELECT 1 FROM bindings WHERE account = ? LIMIT 1").get(account);
}

/** Requests per minute, per address and per route: the page's polling must not use up the bind's allowance. */
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

// --- routes ------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const me = cookieAccount(req);

  if (req.method === "GET" && url.pathname === "/api/state") {
    limit(req, "state", 60);
    const p = phaseAt();
    const poll = await currentPoll();
    const last = db.prepare("SELECT * FROM polls WHERE id < ? ORDER BY id DESC LIMIT 1").get(p.id) as any;
    return send(res, 200, {
      now: Date.now(),
      domain: DOMAIN,
      phase: p.voting ? "vote" : "bind",
      voteOpensAt: p.voteOpensAt,
      closesAt: p.closesAt,
      cooldownMinutes: COOLDOWN_MS / 60_000,
      cycleMinutes: CYCLE_MS / 60_000,
      question: QUESTION,
      options: OPTIONS,
      poll: poll ? { id: poll.id, snapshotBlock: poll.snapshot_block, ...tally(poll.id) } : null,
      last: last ? { id: last.id, snapshotBlock: last.snapshot_block, ...tally(last.id) } : null,
      me: me ? { account: me, myVote: poll ? ((db.prepare("SELECT choice FROM votes WHERE poll_id = ? AND account = ?").get(poll.id, me) as any)?.choice ?? null) : null } : null,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/bindings") {
    limit(req, "bindings", 30);
    const rows = db.prepare("SELECT lock_hash, account, bound_at, bound_block, moved_from FROM bindings ORDER BY bound_at DESC LIMIT 200").all();
    return send(res, 200, { bindings: rows });
  }

  if (req.method === "POST" && url.pathname === "/api/weight") {
    limit(req, "weight", 20);
    const { lock } = await body(req);
    const script = ccc.Script.from(lock);
    const at = await tip();
    const w = await daoWeightAt(RPC_URL, script, at);
    return send(res, 200, { block: at, weight: w.weight, deposits: w.deposits.length, withdrawing: w.withdrawing.length });
  }

  if (req.method === "POST" && url.pathname === "/api/nonce") {
    limit(req, "nonce", 20);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: binding is frozen until it closes (rule 7)");
    const { account, lock } = await body(req);
    if (typeof account !== "string") throw new HttpError(400, "account missing");
    if (owner(account) && me !== account) throw new HttpError(403, "that account belongs to someone else on this demo; pick another name");
    const script = ccc.Script.from(lock);
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    let text: string;
    try {
      text = message({ domain: DOMAIN, account, lock: script, chain: CHAIN, issuedAt, nonce });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    db.prepare("INSERT INTO nonces (nonce, account, lock_hash, lock, message, issued_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      nonce, account, script.hash(), JSON.stringify({ codeHash: script.codeHash, hashType: script.hashType, args: script.args }), text, issuedAt,
    );
    return send(res, 200, { nonce, message: text, template: JSON.parse(proofTemplate(script, text).stringify()) });
  }

  if (req.method === "POST" && url.pathname === "/api/bind") {
    limit(req, "bind", 10);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: binding is frozen until it closes (rule 7)");
    const { nonce, tx } = await body(req);
    const row = db.prepare("SELECT * FROM nonces WHERE nonce = ?").get(String(nonce)) as any;
    if (!row) throw new HttpError(404, "unknown nonce");
    if (owner(row.account) && me !== row.account) throw new HttpError(403, "that account belongs to someone else on this demo");
    const r = await verify(
      { lock: JSON.parse(row.lock), message: row.message, tx },
      {
        rpcUrl: RPC_URL,
        runLock,
        expect: { message: row.message, domain: DOMAIN, account: row.account, nonce: row.nonce, chain: CHAIN, maxAgeSeconds: MAX_AGE_SECONDS },
        // Rule 3: burn the nonce with a compare-and-set before the first chain read.
        claimNonce: () => db.prepare("UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(new Date().toISOString(), row.nonce).changes === 1,
      },
    );
    if (!r.ok) return send(res, 400, { ok: false, reason: r.reason });

    const at = Number(await tip());
    const now = new Date().toISOString();
    const deps = JSON.stringify(r.cellDeps.map((o) => ({ txHash: o.txHash, index: Number(o.index) })));
    const prev = db.prepare("SELECT account FROM bindings WHERE lock_hash = ?").get(row.lock_hash) as any;
    const moved = prev && prev.account !== row.account ? prev.account : null;
    // Rule 6: one binding per lock; binding it to another account moves it, with a cooldown.
    db.prepare(
      "INSERT INTO bindings (lock_hash, lock, account, bound_at, bound_block, moved_from, cell_deps) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (lock_hash) DO UPDATE SET account = excluded.account, bound_at = excluded.bound_at, bound_block = excluded.bound_block, moved_from = excluded.moved_from, cell_deps = excluded.cell_deps",
    ).run(row.lock_hash, row.lock, row.account, now, at, moved, deps);
    db.prepare("INSERT INTO history (lock_hash, account, action, at, block) VALUES (?, ?, ?, ?, ?)").run(row.lock_hash, row.account, moved ? `moved from ${moved}` : "bound", now, at);

    const headers: Record<string, string> = {};
    if (me !== row.account) {
      const token = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO sessions (token, account, created_at) VALUES (?, ?, ?)").run(token, row.account, now);
      headers["set-cookie"] = `ward_demo=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${SECURE_COOKIE ? "; Secure" : ""}`;
    }
    return send(res, 200, { ok: true, account: row.account, lockHash: row.lock_hash, cycles: r.cycles, block: at, movedFrom: moved }, headers);
  }

  if (req.method === "POST" && url.pathname === "/api/unbind") {
    limit(req, "unbind", 10);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: binding is frozen until it closes (rule 7)");
    if (!me) throw new HttpError(401, "bind a lock first");
    const { lockHash } = await body(req);
    const changed = db.prepare("DELETE FROM bindings WHERE lock_hash = ? AND account = ?").run(String(lockHash), me).changes;
    if (changed !== 1) throw new HttpError(404, "no such binding on your account");
    db.prepare("INSERT INTO history (lock_hash, account, action, at, block) VALUES (?, ?, ?, ?, ?)").run(String(lockHash), me, "unbound", new Date().toISOString(), Number(await tip()));
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/vote") {
    limit(req, "vote", 10);
    if (!me) throw new HttpError(401, "bind a lock first");
    const poll = await currentPoll();
    if (!poll) throw new HttpError(409, "no vote is open now");
    const { choice } = await body(req);
    if (!OPTIONS.includes(choice)) throw new HttpError(400, "unknown option");
    const w = await weighAccount(me, poll);
    db.prepare(
      "INSERT INTO votes (poll_id, account, choice, weight, detail, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (poll_id, account) DO UPDATE SET choice = excluded.choice, weight = excluded.weight, detail = excluded.detail, at = excluded.at",
    ).run(poll.id, me, choice, w.total.toString(), JSON.stringify(w.locks), new Date().toISOString());
    return send(res, 200, { ok: true, choice, weight: w.total, locks: w.locks, snapshotBlock: poll.snapshot_block });
  }

  if (req.method === "GET" && url.pathname === "/api/mine") {
    limit(req, "mine", 30);
    if (!me) return send(res, 200, { account: null, bindings: [] });
    // The lock too, so the page can show this account's addresses rather than lock hashes.
    const rows = (db.prepare("SELECT lock_hash, lock, bound_at, bound_block, moved_from FROM bindings WHERE account = ?").all(me) as any[]).map((r) => ({ ...r, lock: JSON.parse(r.lock) }));
    return send(res, 200, { account: me, bindings: rows });
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
    // A read of the public testnet node that timed out or failed: say so, and that a retry helps.
    const node = !(e instanceof HttpError) && /timeout|aborted|fetch failed|get_|ECONN|ETIMEDOUT/i.test(`${(e as Error)?.name} ${(e as Error)?.message}`);
    const code = node ? 503 : status;
    if (code >= 500) console.error(new Date().toISOString(), req.method, req.url, code, e);
    if (!res.headersSent) send(res, code, { ok: false, reason: code === 503 ? "the testnet node did not answer in time; try again" : status === 500 ? "the server could not answer; try again" : (e as Error).message });
  }
}).listen(PORT, () => console.log(`[ward-demo] ${DOMAIN} on :${PORT}, cycle ${CYCLE_MS / 60_000} min, bind ${BIND_MS / 60_000} min`));
