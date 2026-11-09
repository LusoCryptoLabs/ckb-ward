import { useState } from "react";
import { Connect, SignButton, ckb, plainError, useWallet } from "../lib";

type Drop = { account: string; snapshot: number; deposit: string; min: string; eligible: boolean; allocation: string };

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
        Airdrops reward people who held something at a past moment, the snapshot. Prove your wallet and this page checks what it held in the Nervos DAO at the snapshot block, then tells you if
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
          </div>
        ) : (
          <div className="card">
            <p>
              <strong>Not eligible</strong>
            </p>
            <p className="small">
              This airdrop is for wallets that held in the Nervos DAO at block {res.snapshot.toLocaleString("en")}. Yours held {ckb(res.deposit)} then.
            </p>
          </div>
        ))}
    </section>
  );
}
