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
        The core of Ward. Your wallet signs a proof, and the server runs your lock in CKB-VM to check it. It works with every lock, because it runs the lock itself. Nothing is sent to the
        chain.
      </p>
      <Connect />
      {signer && lock && (
        <div className="card">
          <SignButton label="Prove this lock is mine" onClick={run} />
          <p className="small">Not a payment: the proof points at coins that do not exist, so it can never go through. It costs nothing.</p>
        </div>
      )}
      {note && <p className="note bad">{note}</p>}
      {result && (
        <div className="card">
          <p className="ok">
            <strong>✓ The lock accepted the signature.</strong>
          </p>
          <p className="small">Ward resolved the proof's cell deps from the chain and ran your lock on it. It exited 0{result.cycles ? `, in ${Number(result.cycles).toLocaleString("en")} cycles` : ""}.</p>
          <p className="row">
            <span className="small">Lock</span>
            <span>{lock ? lockKind(lock) : ""}</span>
          </p>
          <p className="small">
            Cell deps it ran with ({result.cellDeps.length}). The lock's code and settings live here; the proof stays valid while all of them are live.
          </p>
          {result.cellDeps.map((d) => (
            <p key={`${d.txHash}:${d.index}`} className="mono small">
              {shortHash(d.txHash)}:{d.index}
            </p>
          ))}
        </div>
      )}
    </section>
  );
}
