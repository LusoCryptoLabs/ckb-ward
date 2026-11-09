import { useState } from "react";
import { Connect, SignButton, ckb, plainError, useWallet } from "../lib";

type Gate = { account: string; balance: string; threshold: string; admitted: boolean };

export function TokenGate() {
  const { signer, lock, prove } = useWallet();
  const [res, setRes] = useState<Gate | null>(null);
  const [note, setNote] = useState("");

  const run = async () => {
    setNote("");
    setRes(null);
    try {
      setRes(await prove<Gate>("/api/gate"));
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };

  return (
    <section>
      <p className="lead">
        Holders only. Prove your wallet, and this page checks what it holds on chain, then opens the door if you qualify. It is how a site gates a community, content, or a mint to the people who
        hold enough, without you sending anything. It works with any CKB wallet.
      </p>
      {res?.admitted ? (
        <>
          <div className="card">
            <p className="ok">
              <strong>✓ You are in</strong>
            </p>
            <p className="small">
              You hold {ckb(res.balance)}, at or above the {ckb(res.threshold)} this area needs. Nothing was sent.
            </p>
            <button className="link" onClick={() => setRes(null)}>
              Check another wallet
            </button>
          </div>
          <div className="card">
            <p>
              <strong>Members only</strong>
            </p>
            <p className="small">You can see this because you proved a wallet that holds enough. A real site would open its community, content, or mint here.</p>
          </div>
        </>
      ) : (
        <>
          <Connect />
          {signer && lock && (
            <div className="card">
              <p className="small">This members area is for wallets that hold enough CKB. Prove yours to check, on chain.</p>
              <SignButton label="Prove my wallet and enter" onClick={run} />
              <p className="small">One signature. Not a payment, and nothing is sent.</p>
            </div>
          )}
          {note && <p className="note bad">{note}</p>}
          {res && !res.admitted && (
            <p className="note bad">
              You hold {ckb(res.balance)}, but this area needs {ckb(res.threshold)}. Get more testnet CKB and try again.
            </p>
          )}
        </>
      )}
    </section>
  );
}
