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
import { daoWeightAt, depsLiveAt, jsonRpc, message, proofTemplate, tipEpoch, verify, wardVm } from "../src/index.ts";

const PORT = Number(process.env.PORT ?? 8080);
const DOMAIN = process.env.DOMAIN ?? "ward-play.lusocryptolabs.com";
const DATA_DIR = process.env.DATA_DIR ?? "playground/data";
const STATIC_DIR = fileURLToPath(new URL("./dist/", import.meta.url));
const MAX_BODY = 64 * 1024;
const MAX_AGE_SECONDS = 600;
const SECURE_COOKIE = !/^localhost(:\d+)?$/.test(DOMAIN);
/** The members-area example admits a wallet that holds at least this much CKB (in shannons). */
const GATE_THRESHOLD = BigInt(process.env.GATE_CKB_SHANNONS ?? "10000000000");
/** The airdrop example checks a Nervos DAO deposit at a fixed past block, per network. */
const AIRDROP_SNAPSHOT: Record<"testnet" | "mainnet", number> = { testnet: 23000000, mainnet: 20960000 };
const AIRDROP_MIN = BigInt(process.env.AIRDROP_MIN_SHANNONS ?? "100000000");

// --- DAO voting example: a stateful poll in cycles, testnet only (the full platform of the spec's
// rules 1-10). Binding is open for the first part of each cycle, then a vote opens with its snapshot
// at the tip and binding freezes until it closes.
const VOTE_NET: Net = "testnet";
const CYCLE_MS = Number(process.env.VOTE_CYCLE_MS ?? 15 * 60_000);
const BIND_MS = Number(process.env.VOTE_BIND_MS ?? 10 * 60_000);
const COOLDOWN_MS = Number(process.env.VOTE_COOLDOWN_MS ?? 20 * 60_000);
const QUESTION = "Should Nervos DAO deposits held in any wallet count in community votes?";
const OPTIONS = ["Yes", "No"];

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
  CREATE TABLE IF NOT EXISTS vbindings (lock_hash TEXT PRIMARY KEY, lock TEXT NOT NULL, account TEXT NOT NULL, bound_at TEXT NOT NULL, bound_block INTEGER NOT NULL, moved_from TEXT, cell_deps TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vsessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vpolls (id INTEGER PRIMARY KEY, snapshot_block INTEGER NOT NULL, opened_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS vvotes (poll_id INTEGER NOT NULL, account TEXT NOT NULL, choice TEXT NOT NULL, weight TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (poll_id, account));
  CREATE TABLE IF NOT EXISTS vhistory (id INTEGER PRIMARY KEY AUTOINCREMENT, lock_hash TEXT NOT NULL, account TEXT NOT NULL, action TEXT NOT NULL, at TEXT NOT NULL, block INTEGER);
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

/** Parse a lock from a request, turning a malformed one into a 400 rather than a 500. */
function parseLock(lock: unknown): ccc.Script {
  try {
    return ccc.Script.from(lock as ccc.ScriptLike);
  } catch {
    throw new HttpError(400, "bad lock");
  }
}

/** Issue a message and its template for a lock on one network. The account is the caller's own choice (the demos use the address). */
async function issue(account: string, lockLike: ccc.ScriptLike, network: Net) {
  const script = parseLock(lockLike);
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

/** Total CKB (shannons) in live cells under a lock, from the node's indexer. */
async function balanceOf(n: Net, lockLike: ccc.ScriptLike): Promise<bigint> {
  const lock = ccc.Script.from(lockLike);
  const key = { script: { code_hash: lock.codeHash, hash_type: lock.hashType, args: lock.args }, script_type: "lock" };
  let sum = 0n;
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r: any = await rpcs[n]("get_cells", [key, "asc", "0x3e8", cursor ?? null]);
    for (const c of r.objects) sum += BigInt(c.output.capacity);
    if (!r.last_cursor || r.last_cursor === "0x" || r.objects.length < 1000) break;
    cursor = r.last_cursor;
  }
  return sum;
}

// --- DAO voting (testnet) ----------------------------------------------------------------------

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
  const row = db.prepare("SELECT * FROM vpolls WHERE id = ?").get(p.id) as any;
  if (row) return row;
  const block = await retry(() => tip(VOTE_NET));
  db.prepare("INSERT OR IGNORE INTO vpolls (id, snapshot_block, opened_at) VALUES (?, ?, ?)").run(p.id, Number(block), new Date().toISOString());
  return db.prepare("SELECT * FROM vpolls WHERE id = ?").get(p.id) as any;
}

function tally(pollId: number) {
  const votes = db.prepare("SELECT account, choice, weight, detail FROM vvotes WHERE poll_id = ? ORDER BY at").all(pollId) as any[];
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

/** What each of an account's locks weighs in a poll, and why a lock does not count. */
async function weighAccount(account: string, poll: { snapshot_block: number; opened_at: string }) {
  const bindings = db.prepare("SELECT * FROM vbindings WHERE account = ?").all(account) as any[];
  const snapshot = BigInt(poll.snapshot_block);
  let total = 0n;
  const locks = [];
  for (const b of bindings) {
    const item: { lockHash: string; weight: string; counted: boolean; reason: string } = { lockHash: b.lock_hash, weight: "0", counted: false, reason: "" };
    if (BigInt(b.bound_block) >= snapshot) item.reason = "bound at or after the snapshot block";
    else if (b.moved_from && Date.parse(poll.opened_at) - Date.parse(b.bound_at) < COOLDOWN_MS) item.reason = `moved from ${b.moved_from}, still in its cooldown`;
    else {
      const key = `${poll.snapshot_block} ${b.lock_hash} ${b.cell_deps}`;
      let found = weighed.get(key);
      if (!found) {
        found = await retry(async () => {
          if (!(await depsLiveAt(RPC[VOTE_NET], JSON.parse(b.cell_deps), snapshot)).live) return { live: false, weight: 0n, deposits: 0, withdrawing: 0 };
          const w = await daoWeightAt(RPC[VOTE_NET], JSON.parse(b.lock), snapshot);
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

function voterCookie(req: IncomingMessage): string | undefined {
  const m = /(?:^|;\s*)ward_vote=([0-9a-f]{64})/.exec(req.headers.cookie ?? "");
  if (!m) return undefined;
  return (db.prepare("SELECT account FROM vsessions WHERE token = ?").get(m[1]) as any)?.account;
}
function voterOwner(account: string): boolean {
  return !!db.prepare("SELECT 1 FROM vbindings WHERE account = ? LIMIT 1").get(account);
}

// --- routes ------------------------------------------------------------------------------------

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://x");
  const session = cookieSession(req);
  const voter = voterCookie(req);

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

  if (req.method === "POST" && url.pathname === "/api/gate") {
    limit(req, "gate", 20);
    const { nonce, tx } = await body(req);
    const { row, network, result } = await checkProof(nonce, tx);
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    const balance = await balanceOf(network, JSON.parse(row.lock));
    return send(res, 200, { ok: true, account: row.account, balance, threshold: GATE_THRESHOLD, admitted: balance >= GATE_THRESHOLD });
  }

  if (req.method === "POST" && url.pathname === "/api/airdrop") {
    limit(req, "airdrop", 20);
    const { nonce, tx } = await body(req);
    const { row, network, result } = await checkProof(nonce, tx);
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    const snapshot = AIRDROP_SNAPSHOT[network];
    const w = await daoWeightAt(RPC[network], JSON.parse(row.lock), snapshot);
    const deposit = w.weight;
    return send(res, 200, { ok: true, account: row.account, snapshot, deposit, min: AIRDROP_MIN, eligible: deposit >= AIRDROP_MIN, allocation: deposit >= AIRDROP_MIN ? deposit : 0n });
  }

  if (req.method === "POST" && url.pathname === "/api/balance") {
    limit(req, "balance", 30);
    const { nonce, tx } = await body(req);
    const { row, network, result } = await checkProof(nonce, tx);
    if (!result.ok) return send(res, 400, { ok: false, reason: result.reason });
    const balance = await balanceOf(network, JSON.parse(row.lock));
    return send(res, 200, { ok: true, account: row.account, lockHash: row.lock_hash, balance });
  }

  if (req.method === "GET" && url.pathname === "/api/vote/state") {
    limit(req, "vote-state", 60);
    const p = phaseAt();
    const poll = await currentPoll();
    const last = db.prepare("SELECT * FROM vpolls WHERE id < ? ORDER BY id DESC LIMIT 1").get(p.id) as any;
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
      me: voter ? { account: voter, myVote: poll ? ((db.prepare("SELECT choice FROM vvotes WHERE poll_id = ? AND account = ?").get(poll.id, voter) as any)?.choice ?? null) : null } : null,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/vote/bindings") {
    limit(req, "vote-bindings", 30);
    const rows = db.prepare("SELECT lock_hash, account, bound_at, bound_block, moved_from FROM vbindings ORDER BY bound_at DESC LIMIT 200").all();
    return send(res, 200, { bindings: rows });
  }

  if (req.method === "POST" && url.pathname === "/api/vote/nonce") {
    limit(req, "vote-nonce", 30);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: sign-up is frozen until it closes");
    const { account, lock } = await body(req);
    if (typeof account !== "string" || !account) throw new HttpError(400, "account missing");
    if (voterOwner(account) && voter !== account) throw new HttpError(403, "that name is taken; pick another");
    const script = parseLock(lock);
    const nonce = randomBytes(16).toString("hex");
    const issuedAt = new Date().toISOString();
    let text: string;
    try {
      text = message({ domain: DOMAIN, account, lock: script, chain: GENESIS[VOTE_NET], issuedAt, nonce });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    db.prepare("INSERT INTO nonces (nonce, account, lock_hash, lock, message, network, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      nonce, account, script.hash(), JSON.stringify({ codeHash: script.codeHash, hashType: script.hashType, args: script.args }), text, VOTE_NET, issuedAt,
    );
    return send(res, 200, { nonce, message: text, template: JSON.parse(proofTemplate(script, text).stringify()) });
  }

  if (req.method === "POST" && url.pathname === "/api/vote/bind") {
    limit(req, "vote-bind", 10);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: sign-up is frozen until it closes");
    const { nonce, tx } = await body(req);
    const row = db.prepare("SELECT * FROM nonces WHERE nonce = ?").get(String(nonce)) as any;
    if (!row) throw new HttpError(404, "unknown nonce");
    if (voterOwner(row.account) && voter !== row.account) throw new HttpError(403, "that name is taken");
    const r = await verify(
      { lock: JSON.parse(row.lock), message: row.message, tx: tx as ccc.TransactionLike },
      {
        rpcUrl: RPC[VOTE_NET],
        runLock: runLocks[VOTE_NET],
        expect: { message: row.message, domain: DOMAIN, account: row.account, nonce: row.nonce, chain: GENESIS[VOTE_NET], maxAgeSeconds: MAX_AGE_SECONDS },
        claimNonce: () => db.prepare("UPDATE nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL").run(new Date().toISOString(), row.nonce).changes === 1,
      },
    );
    if (!r.ok) return send(res, 400, { ok: false, reason: r.reason });
    const at = Number(await tip(VOTE_NET));
    const now = new Date().toISOString();
    const deps = JSON.stringify(r.cellDeps.map((o) => ({ txHash: o.txHash, index: Number(o.index) })));
    const prev = db.prepare("SELECT account FROM vbindings WHERE lock_hash = ?").get(row.lock_hash) as any;
    const moved = prev && prev.account !== row.account ? prev.account : null;
    db.prepare(
      "INSERT INTO vbindings (lock_hash, lock, account, bound_at, bound_block, moved_from, cell_deps) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (lock_hash) DO UPDATE SET account = excluded.account, bound_at = excluded.bound_at, bound_block = excluded.bound_block, moved_from = excluded.moved_from, cell_deps = excluded.cell_deps",
    ).run(row.lock_hash, row.lock, row.account, now, at, moved, deps);
    db.prepare("INSERT INTO vhistory (lock_hash, account, action, at, block) VALUES (?, ?, ?, ?, ?)").run(row.lock_hash, row.account, moved ? `moved from ${moved}` : "bound", now, at);
    const headers: Record<string, string> = {};
    if (voter !== row.account) {
      const token = randomBytes(32).toString("hex");
      db.prepare("INSERT INTO vsessions (token, account, created_at) VALUES (?, ?, ?)").run(token, row.account, now);
      headers["set-cookie"] = `ward_vote=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000${SECURE_COOKIE ? "; Secure" : ""}`;
    }
    return send(res, 200, { ok: true, account: row.account, lockHash: row.lock_hash, cycles: r.cycles, block: at, movedFrom: moved }, headers);
  }

  if (req.method === "POST" && url.pathname === "/api/vote/unbind") {
    limit(req, "vote-unbind", 10);
    if (phaseAt().voting) throw new HttpError(409, "a vote is open: sign-up is frozen until it closes");
    if (!voter) throw new HttpError(401, "sign up first");
    const { lockHash } = await body(req);
    const changed = db.prepare("DELETE FROM vbindings WHERE lock_hash = ? AND account = ?").run(String(lockHash), voter).changes;
    if (changed !== 1) throw new HttpError(404, "no such sign-up on your name");
    db.prepare("INSERT INTO vhistory (lock_hash, account, action, at, block) VALUES (?, ?, ?, ?, ?)").run(String(lockHash), voter, "unbound", new Date().toISOString(), Number(await tip(VOTE_NET)));
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === "/api/vote/cast") {
    limit(req, "vote-cast", 10);
    if (!voter) throw new HttpError(401, "sign up first");
    const poll = await currentPoll();
    if (!poll) throw new HttpError(409, "no vote is open now");
    const { choice } = await body(req);
    if (!OPTIONS.includes(choice)) throw new HttpError(400, "unknown option");
    const w = await weighAccount(voter, poll);
    db.prepare(
      "INSERT INTO vvotes (poll_id, account, choice, weight, detail, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (poll_id, account) DO UPDATE SET choice = excluded.choice, weight = excluded.weight, detail = excluded.detail, at = excluded.at",
    ).run(poll.id, voter, choice, w.total.toString(), JSON.stringify(w.locks), new Date().toISOString());
    return send(res, 200, { ok: true, choice, weight: w.total, locks: w.locks, snapshotBlock: poll.snapshot_block });
  }

  if (req.method === "GET" && url.pathname === "/api/vote/mine") {
    limit(req, "vote-mine", 30);
    if (!voter) return send(res, 200, { account: null, bindings: [] });
    const rows = (db.prepare("SELECT lock_hash, lock, bound_at, bound_block, moved_from FROM vbindings WHERE account = ?").all(voter) as any[]).map((r) => ({ ...r, lock: JSON.parse(r.lock) }));
    return send(res, 200, { account: voter, bindings: rows });
  }

  if (req.method === "POST" && url.pathname === "/api/weight") {
    limit(req, "weight", 20);
    const { lock, network } = await body(req);
    const n = net(network);
    const script = parseLock(lock);
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
