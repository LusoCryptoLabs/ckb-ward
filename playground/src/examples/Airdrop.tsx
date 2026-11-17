import { useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { Connect, SignButton, api, ckb, plainError, shortAddress, shortHash, useWallet } from "../lib";

type Drop = {
  account: string;
  snapshot: number;
  deposit: string;
  ckbDays: number;
  deposits: { capacity: string; block: string; days: number }[];
  withdrawing: number;
  claim?: Offer;
  min: string;
  eligible: boolean;
  allocation: string;
};

type Offer = { pool: string; totalDeposits: string; amount: string; ticket?: string; claimed?: { amount: string; to: string; txHash: string } };

const TOKEN = "DROP";
/** Token units (8 decimals) as a number with up to 8 decimals. */
const drop = (units: string | bigint) => {
  const n = BigInt(units);
  const frac = (n % 100_000_000n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${(n / 100_000_000n).toLocaleString("en")}${frac ? `.${frac}` : ""} ${TOKEN}`;
};
/** A share as a percentage with enough digits to show a small one. */
const percent = (part: string, whole: string) => {
  const ppb = (BigInt(part) * 100_000_000_000n) / BigInt(whole); // percent times 1e9
  const v = Number(ppb) / 1e9;
  return `${v.toLocaleString("en", { maximumSignificantDigits: 3 })}%`;
};
const EXPLORER = "https://testnet.explorer.nervos.org/transaction/";

/** The claim: your share of a test token pool, sent where you choose, in one transaction you sign. */
function Claim({ r }: { r: Drop }) {
  const { signer, address } = useWallet();
  const offer = r.claim!;
  const [to, setTo] = useState(address);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const [done, setDone] = useState(offer.claimed ?? null);

  const run = async () => {
    if (!signer || !offer.ticket) return;
    setNote("");
    try {
      setBusy("Preparing the claim…");
      const p = await api<{ claimId: string; tx: ccc.TransactionLike }>("/api/claim/prepare", { ticket: offer.ticket, to: to.trim() });
      const tx = ccc.Transaction.from(p.tx);
      setBusy("Adding the CKB for the token cell…");
      await tx.completeInputsByCapacity(signer);
      await tx.completeFeeBy(signer);
      setBusy("Confirm in your wallet…");
      const signed = await signer.signTransaction(tx);
      setBusy("Sending…");
      setDone(await api<{ txHash: string; amount: string; to: string }>("/api/claim/send", { claimId: p.claimId, tx: JSON.parse(signed.stringify()) }));
    } catch (e) {
      const m = (e as Error).message;
      setNote(/insufficient|not enough|InsufficientCapacity/i.test(m) ? "This wallet needs about 150 spare testnet CKB to hold the token cell and pay the fee. Get some from the testnet faucet and try again." : plainError(m));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="card">
      <p>
        <strong>Your share</strong>
      </p>
      <p className="small">
        All Nervos DAO deposits on testnet at the snapshot: {ckb(offer.totalDeposits)}. Yours is {percent(r.deposit, offer.totalDeposits)} of that, so you get{" "}
        <strong>{drop(offer.amount)}</strong> of the {drop(offer.pool)} pool. Same share of the deposits, same share of the tokens, whatever wallet you use.
      </p>
      {done ? (
        <p className="ok">
          <strong>✓ Claimed {drop(done.amount)}</strong>
          <br />
          <span className="small">
            Sent to {shortAddress(done.to)}.{" "}
            <a href={EXPLORER + done.txHash} target="_blank" rel="noreferrer">
              See the transaction {shortHash(done.txHash)} ↗
            </a>
          </span>
        </p>
      ) : offer.ticket ? (
        <>
          <label className="small" htmlFor="claim-to">
            Send the tokens to (any testnet address, yours by default)
          </label>
          <input id="claim-to" className="mono" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
          <button className="primary" disabled={!!busy} onClick={run}>
            {busy || `Claim ${drop(offer.amount)}`}
          </button>
          <p className="small">
            A real testnet transaction, signed in your wallet. You put up the CKB the token cell holds (about 144 CKB, and it stays in that cell, with the tokens) plus a small fee.
            Nobody pays to send tokens to wallets that never come for them.
          </p>
        </>
      ) : (
        <p className="small">Your share rounds to zero.</p>
      )}
      {note && <p className="note bad">{note}</p>}
    </div>
  );
}

const days = (n: number) => {
  if (n < 1 / 24) return "under an hour";
  if (n < 1) return `${Math.round(n * 24)} ${Math.round(n * 24) === 1 ? "hour" : "hours"}`;
  return `${n.toLocaleString("en", { maximumFractionDigits: n < 10 ? 1 : 0 })} ${n === 1 ? "day" : "days"}`;
};

/** Each deposit counted, and the score: CKB times days held, as Nervos DAO airdrops have ranked. */
function Score({ r }: { r: Drop }) {
  return (
    <>
      <p className="small">
        Score: <strong>{r.ckbDays.toLocaleString("en", { maximumFractionDigits: 2 })} CKB-days</strong>, each deposit's CKB times the days it was in the Nervos DAO before the snapshot.
        Airdrops to depositors have ranked people by this, so a long deposit counts more than a big one made the day before.
      </p>
      <ul className="small">
        {r.deposits.map((d, i) => (
          <li key={i}>
            {ckb(d.capacity)} since block {Number(d.block).toLocaleString("en")}, {days(d.days)}
          </li>
        ))}
      </ul>
      {r.withdrawing > 0 && <p className="small">Not counted: {r.withdrawing === 1 ? "one deposit" : `${r.withdrawing} deposits`} already on the way out (withdrawal requested).</p>}
    </>
  );
}

export function Airdrop() {
  const { signer, lock, prove } = useWallet();
  const [res, setRes] = useState<Drop | null>(null);
  const [note, setNote] = useState("");

  const run = async () => {
    setNote("");
    setRes(null);
    try {
      setRes(await prove<Drop>("/api/airdrop"));
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };

  return (
    <section>
      <p className="lead">
        Airdrops reward people who held something at a past moment, the snapshot. Prove your wallet and this page checks what it held in the Nervos DAO at the snapshot block, and for how long, then tells you if
        you qualify, without you sending anything. On testnet you can then claim your share of a test token pool. It works with any CKB wallet.
      </p>
      <Connect />
      {signer && lock && (
        <div className="card">
          <SignButton label="Check my airdrop" onClick={run} />
          <p className="small">One signature. Not a payment, and nothing is sent.</p>
        </div>
      )}
      {note && <p className="note bad">{note}</p>}
      {res &&
        (res.eligible ? (
          <>
            <div className="card">
              <p className="ok">
                <strong>✓ You qualify</strong>
              </p>
              <p className="small">
                You held {ckb(res.deposit)} in the Nervos DAO at the snapshot (block {res.snapshot.toLocaleString("en")}).{" "}
                {res.claim ? "Below is your share of a test token pool, and the claim." : "A real airdrop would send you an allocation now, often proportional to that."}
              </p>
              <Score r={res} />
            </div>
            {res.claim && <Claim r={res} />}
          </>
        ) : (
          <div className="card">
            <p>
              <strong>Not eligible</strong>
            </p>
            <p className="small">
              This airdrop is for wallets that held in the Nervos DAO at block {res.snapshot.toLocaleString("en")}. Yours held {ckb(res.deposit)} then.
            </p>
            {res.withdrawing > 0 && <Score r={res} />}
          </div>
        ))}
    </section>
  );
}
