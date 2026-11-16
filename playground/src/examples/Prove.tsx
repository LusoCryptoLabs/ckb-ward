import { useEffect, useState } from "react";
import { loadVerifier, type InPage } from "../inpage";
import { Connect, SignButton, lockKind, plainError, shortHash, useWallet } from "../lib";

export function Prove() {
  const { signer, lock, proveHere } = useWallet();
  const [result, setResult] = useState<Extract<InPage, { ok: true }> | null>(null);
  const [note, setNote] = useState("");

  // Load the checker while the wallet connects, so the check starts as soon as the wallet signs.
  useEffect(() => {
    loadVerifier().catch(() => {});
  }, []);

  const run = async () => {
    setNote("");
    setResult(null);
    try {
      const r = await proveHere();
      if (r.ok) setResult(r);
      else setNote(plainError(r.reason));
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };

  return (
    <section>
      <p className="lead">
        Show that a wallet belongs to you. You sign once, and this page checks, by itself, that the signature really came from your wallet. The proof never leaves this page, nothing is sent
        and it costs nothing. This is how a site can link your wallet to an account, or let you prove you hold what you hold, without moving anything. It works with any CKB wallet.
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
          <p className="small">This page checked your signature itself, with the very program your wallet uses to approve a transaction, and it accepted. Your proof was not sent to our server.</p>
          <details className="dev">
            <summary>For developers</summary>
            <p className="small">
              Ward ran the lock in CKB-VM inside this page, with{" "}
              <a href="https://github.com/Hanssen0-Alter-Ego/ckb-vm-js" target="_blank" rel="noreferrer">
                ckb-vm-js
              </a>{" "}
              (CKB's own verifier in WebAssembly), and it exited 0 in {Number(result.cycles).toLocaleString("en")} cycles. The whole check, with the chain reads, took{" "}
              {(result.ms / 1000).toFixed(1)} s. Lock: {lock ? lockKind(lock) : ""}.
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
