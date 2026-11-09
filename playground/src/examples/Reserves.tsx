import { useState } from "react";
import { Connect, SignButton, ckb, plainError, shortAddress, useWallet } from "../lib";

type Proven = { account: string; lockHash: string; balance: string };

export function Reserves() {
  const { signer, lock, prove } = useWallet();
  const [proven, setProven] = useState<Proven[]>([]);
  const [note, setNote] = useState("");

  const add = async () => {
    setNote("");
    try {
      const r = await prove<Proven>("/api/balance");
      setProven((list) => (list.some((p) => p.lockHash === r.lockHash) ? list : [...list, r]));
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };

  const total = proven.reduce((s, p) => s + BigInt(p.balance), 0n);

  return (
    <section>
      <p className="lead">
        Proof of reserves is the hard half of showing you are solvent: proving the addresses are really yours. Prove each address you control and this page adds up the CKB you can prove,
        without moving anything. It works with any CKB wallet.
      </p>
      <Connect />
      {signer && lock && (
        <div className="card">
          <p className="small">Pick an address above, prove it, and it joins your proven reserves. Pick another and prove it to add more.</p>
          <SignButton label="Prove the selected address" onClick={add} />
        </div>
      )}
      {note && <p className="note bad">{note}</p>}
      {proven.length > 0 && (
        <div className="card">
          <p className="big">
            {ckb(total.toString())} <span className="small">proven across {proven.length} {proven.length === 1 ? "address" : "addresses"}</span>
          </p>
          {proven.map((p) => (
            <p key={p.lockHash} className="row">
              <span className="mono">{shortAddress(p.account)}</span>
              <span>{ckb(p.balance)}</span>
            </p>
          ))}
          <button className="link" onClick={() => setProven([])}>
            Start over
          </button>
        </div>
      )}
    </section>
  );
}
