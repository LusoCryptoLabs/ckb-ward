import { useState } from "react";
import { Connect, SignButton, ckb, plainError, useWallet } from "../lib";

type Drop = {
  account: string;
  snapshot: number;
  deposit: string;
  ckbDays: number;
  deposits: { capacity: string; block: string; days: number }[];
  withdrawing: number;
  min: string;
  eligible: boolean;
  allocation: string;
};

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
        you qualify, without you sending anything. It works with any CKB wallet.
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
          <div className="card">
            <p className="ok">
              <strong>✓ You qualify</strong>
            </p>
            <p className="small">
              You held {ckb(res.deposit)} in the Nervos DAO at the snapshot (block {res.snapshot.toLocaleString("en")}). A real airdrop would send you an allocation now, often proportional to
              that.
            </p>
            <Score r={res} />
          </div>
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
