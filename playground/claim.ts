// The airdrop claim example, testnet only: a fixed pool of a test token (xUDT) split by each
// depositor's share of all CKB in Nervos DAO deposits at the snapshot. A Ward proof checks the
// deposit and earns a short ticket; the claim is a real transaction that the claimer completes and
// signs (they pay the token cell's CKB and the fee), and the pool's key signs only its own input.
//
// The pool's lock is not the token's owner lock, so a claim can never mint: xUDT checks that the
// tokens out are no more than the tokens in. The server still checks that the outputs it built are
// unchanged and that no other input is the pool's, because the pool's signature covers every input
// under its lock.
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ccc } from "@ckb-ccc/core";

export interface ClaimConfig {
  rpcUrl: string;
  /** Hex private key of the pool (testnet). */
  poolKey: string;
  /** The test token's type script. */
  token: ccc.ScriptLike;
  /** Whole pool in token units (8 decimals). */
  pool: bigint;
  /** Shannons in Nervos DAO deposits live at the snapshot, all locks. */
  totalDeposits: bigint;
}

export class ClaimError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const TICKET_MS = 10 * 60_000;
const BUSY_MS = 5 * 60_000;
const le16 = (n: bigint) => ccc.hexFrom(ccc.numLeToBytes(n, 16));
const amountOf = (data: ccc.HexLike) => ccc.numLeFromBytes(ccc.bytesFrom(data).slice(0, 16));
const key = (o: ccc.OutPointLike) => `${ccc.hexFrom(o.txHash)}:${Number(o.index)}`;

export function createClaims(cfg: ClaimConfig, db: DatabaseSync) {
  const client = new ccc.ClientPublicTestnet({ url: cfg.rpcUrl });
  const pool = new ccc.SignerCkbPrivateKey(client, cfg.poolKey);
  const token = ccc.Script.from(cfg.token);
  db.exec("CREATE TABLE IF NOT EXISTS claims (lock_hash TEXT PRIMARY KEY, amount TEXT NOT NULL, to_address TEXT NOT NULL, tx_hash TEXT, at TEXT NOT NULL)");
  const tickets = new Map<string, { lockHash: string; amount: bigint; exp: number }>();
  const pending = new Map<string, { lockHash: string; amount: bigint; to: string; pool: string; outputs: string; exp: number }>();
  const busy = new Map<string, number>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of tickets) if (v.exp < now) tickets.delete(k);
    for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
    for (const [k, v] of busy) if (v < now) busy.delete(k);
  };
  const claimed = (lockHash: string) => db.prepare("SELECT amount, to_address, tx_hash FROM claims WHERE lock_hash = ? AND tx_hash IS NOT NULL").get(lockHash) as any;
  /** The two outputs a claim must carry, as bytes, to compare what comes back. */
  const shape = (tx: ccc.Transaction) => tx.outputs.slice(0, 2).map((o, i) => ccc.hexFrom(o.toBytes()) + tx.outputsData[i]).join("|");

  return {
    /** Share of the pool for a deposit weight, and a ticket to claim it, after a Ward proof. */
    offer(lockHash: string, weight: bigint) {
      sweep();
      const amount = (cfg.pool * weight) / cfg.totalDeposits;
      const base = { pool: cfg.pool, totalDeposits: cfg.totalDeposits, amount };
      const done = claimed(lockHash);
      if (done) return { ...base, claimed: { amount: done.amount, to: done.to_address, txHash: done.tx_hash } };
      if (amount === 0n) return base;
      const ticket = randomBytes(16).toString("hex");
      tickets.set(ticket, { lockHash, amount, exp: Date.now() + TICKET_MS });
      return { ...base, ticket };
    },

    /** The claim transaction, with the pool's input and the two outputs, for the claimer to complete. */
    async prepare(ticket: string, to: string) {
      sweep();
      const t = tickets.get(ticket);
      if (!t) throw new ClaimError(410, "this check has expired; check again");
      if (claimed(t.lockHash)) throw new ClaimError(409, "this deposit has already claimed");
      if (!/^ckt1/.test(to)) throw new ClaimError(400, "send to a testnet address (ckt1...)");
      const dest = await ccc.Address.fromString(to, client).then((a) => a.script, () => {
        throw new ClaimError(400, "not a testnet address");
      });
      const poolLock = (await pool.getRecommendedAddressObj()).script;
      let cell: ccc.Cell | undefined;
      for await (const c of client.findCells({ script: poolLock, scriptType: "lock", filter: { script: token }, scriptSearchMode: "exact", withData: true })) {
        if (busy.has(key(c.outPoint)) || !c.cellOutput.type?.eq(token)) continue;
        if (amountOf(c.outputData) >= t.amount) {
          cell = c;
          break;
        }
      }
      if (!cell) throw new ClaimError(409, "the pool is busy; try again in a minute");
      const tx = ccc.Transaction.from({
        inputs: [{ previousOutput: cell.outPoint }],
        outputs: [
          { lock: dest, type: token },
          { lock: poolLock, type: token, capacity: cell.cellOutput.capacity },
        ],
        outputsData: [le16(t.amount), le16(amountOf(cell.outputData) - t.amount)],
      });
      await tx.addCellDepsOfKnownScripts(client, ccc.KnownScript.XUdt);
      const ready = await pool.prepareTransaction(tx);
      const claimId = randomBytes(16).toString("hex");
      busy.set(key(cell.outPoint), Date.now() + BUSY_MS);
      pending.set(claimId, { lockHash: t.lockHash, amount: t.amount, to, pool: key(cell.outPoint), outputs: shape(ready), exp: Date.now() + TICKET_MS });
      tickets.delete(ticket);
      return { claimId, amount: t.amount, tx: JSON.parse(ready.stringify()) };
    },

    /** Checks the claimer's completed and signed transaction, signs the pool's input, sends it. */
    async send(claimId: string, txLike: unknown) {
      sweep();
      const p = pending.get(claimId);
      if (!p) throw new ClaimError(410, "this claim has expired; check again");
      const tx = ccc.Transaction.from(txLike as ccc.TransactionLike);
      if (!tx.inputs[0] || key(tx.inputs[0].previousOutput) !== p.pool) throw new ClaimError(400, "the pool's input changed");
      if (shape(tx) !== p.outputs) throw new ClaimError(400, "the claim's outputs changed");
      const poolHash = (await pool.getRecommendedAddressObj()).script.hash();
      for (const input of tx.inputs.slice(1)) {
        const c = await client.getCell(input.previousOutput);
        if (!c) throw new ClaimError(400, "an input is not live");
        if (c.cellOutput.lock.hash() === poolHash) throw new ClaimError(400, "only one input may be the pool's");
      }
      // Claim the deposit before sending, so two claims at once cannot both land.
      const at = new Date().toISOString();
      const ins = db.prepare("INSERT INTO claims (lock_hash, amount, to_address, tx_hash, at) VALUES (?, ?, ?, NULL, ?) ON CONFLICT DO NOTHING").run(p.lockHash, p.amount.toString(), p.to, at);
      if (ins.changes !== 1) throw new ClaimError(409, "this deposit has already claimed, or a claim is on its way");
      try {
        const signed = await pool.signOnlyTransaction(tx);
        const txHash = await client.sendTransaction(signed);
        db.prepare("UPDATE claims SET tx_hash = ? WHERE lock_hash = ?").run(txHash, p.lockHash);
        pending.delete(claimId);
        return { txHash, amount: p.amount, to: p.to };
      } catch (e) {
        db.prepare("DELETE FROM claims WHERE lock_hash = ? AND tx_hash IS NULL").run(p.lockHash);
        throw new ClaimError(400, `the node refused the claim: ${(e as Error).message.slice(0, 300)}`);
      }
    },
  };
}
