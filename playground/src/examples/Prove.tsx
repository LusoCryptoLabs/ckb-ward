import { useState } from "react";
import { Connect, SignButton, lockKind, plainError, shortHash, useWallet } from "../lib";

type Fields = { domain: string; account: string; lockHash: string; chain: string; issuedAt: string; nonce: string };
type Ok = { ok: true; fields: Fields; cycles?: string; cellDeps: { txHash: string; index: number }[] };

export function Prove() {
  const { signer, lock, prove } = useWallet();
  const [result, setResult] = useState<Ok | null>(null);
  const [note, setNote] = useState("");

  const run = async () => {
    setNote("");
    setResult(null);
    try {
      setResult(await prove<Ok>("/api/verify"));
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };

  return (
    <section>
      <p className="lead">
        Show that a wallet belongs to you. You sign once, and this page checks that the signature really came from your wallet. Nothing is sent and it costs nothing. This is how a site can
        link your wallet to an account, or let you prove you hold what you hold, without moving anything. It works with any CKB wallet.
      </p>
      <Connect />
      {signer && lock && (
        <div className="card">
          <SignButton label="Prove this wallet is mine" onClick={run} />
          <p className="small">This is not a payment. What you sign can never move coins, so it costs nothing.</p>
        </div>
      )}
      {note && <p className="note bad">{note}</p>}
      {result && (
        <div className="card">
          <p className="ok">
            <strong>✓ Done. This wallet is yours.</strong>
          </p>
          <p className="small">We checked your signature with the very program your wallet uses to approve a transaction, and it accepted. Nothing was sent.</p>
          <details className="dev">
            <summary>For developers</summary>
            <p className="small">
              Ward ran the lock in CKB-VM and it exited 0{result.cycles ? `, in ${Number(result.cycles).toLocaleString("en")} cycles` : ""}. Lock: {lock ? lockKind(lock) : ""}.
            </p>
            <p className="small">Cell deps it ran with ({result.cellDeps.length}); the proof stays valid while all of them are live:</p>
            {result.cellDeps.map((d) => (
              <p key={`${d.txHash}:${d.index}`} className="mono small">
                {shortHash(d.txHash)}:{d.index}
              </p>
            ))}
          </details>
        </div>
      )}
    </section>
  );
}
