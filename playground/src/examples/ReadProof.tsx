import { useEffect, useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { message, proofTemplate, readProof } from "../../../src/wallet.ts";
import { shortHash, useWallet } from "../lib";

const GENESIS: Record<string, string> = {
  testnet: "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606",
  mainnet: "0x92b197aa1fba0f63633922c61c92375c9c074a93e85963554f5499fe1450d0e5",
};
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

type Fields = { domain: string; account: string; lockHash: string; chain: string; issuedAt: string; nonce: string };

export function ReadProof() {
  const { lock, network, domain } = useWallet();
  const sample = useMemo(() => {
    const lk = ccc.Script.from({ codeHash: SECP, hashType: "type", args: `0x${"ab".repeat(20)}` });
    const text = message({ domain: "dao.example", account: "alice", lock: lk, chain: GENESIS.testnet, issuedAt: "2026-11-04T18:00:00Z", nonce: "demo-nonce" });
    return JSON.stringify(JSON.parse(proofTemplate(lk, text).stringify()), null, 2);
  }, []);
  const [input, setInput] = useState(sample);
  const [fields, setFields] = useState<Fields | null>(null);
  const [note, setNote] = useState("");
  const [mine, setMine] = useState(false);

  const read = (text: string) => {
    setNote("");
    setFields(null);
    let tx: ccc.Transaction;
    try {
      tx = ccc.Transaction.from(JSON.parse(text));
    } catch {
      setNote("That is not a request in JSON.");
      return;
    }
    const l = tx.inputs[0]?.cellOutput?.lock;
    if (!l) {
      setNote("This request has nothing to check against.");
      return;
    }
    const f = readProof(tx, l);
    if (!f) {
      setNote("This is not a request to prove a wallet.");
      return;
    }
    setFields(f as Fields);
  };

  // Read the sample straight away, so the plain result is the first thing seen.
  useEffect(() => read(sample), [sample]);

  // Build a real request for the connected wallet and read it, so the result is the person's own.
  const seeMine = () => {
    if (!lock) return;
    const text = message({ domain, account: "you", lock, chain: GENESIS[network], issuedAt: new Date(), nonce: Math.random().toString(36).slice(2, 12) });
    const tx = JSON.stringify(JSON.parse(proofTemplate(lock, text).stringify()), null, 2);
    setInput(tx);
    setMine(true);
    read(tx);
  };

  return (
    <section>
      <p className="lead">
        When a site asks you to prove your wallet, a good wallet shows you who is asking and what for, not a confusing transaction. Here is what your wallet would make of such a request: who is
        asking, the account, the time.
      </p>
      <p className="small dev-note">
        For developers: this runs entirely in your browser with <code>readProof</code> from <code>ckb-ward/wallet</code>. No server.
      </p>
      {lock && (
        <div className="card">
          <p className="small">
            <strong>Try it.</strong> Make a request for the wallet you connected and see what it would show you.
          </p>
          <button className="primary" onClick={seeMine}>
            See a request for my wallet
          </button>
        </div>
      )}
      {note && <p className="note bad">{note}</p>}
      {fields && (
        <div className="card">
          <p className="ok">
            <strong>✓ A request to prove a wallet{mine ? " (yours)" : ""}</strong>
          </p>
          <p className="small">Your wallet shows who is asking and the account, instead of a transaction:</p>
          <p className="row">
            <span className="small">Site</span>
            <span>{fields.domain}</span>
          </p>
          <p className="row">
            <span className="small">Account</span>
            <span className="mono">{fields.account}</span>
          </p>
          <p className="row">
            <span className="small">Wallet</span>
            <span className="mono">{shortHash(fields.lockHash)}</span>
          </p>
          <p className="row">
            <span className="small">Network</span>
            <span className="mono">{shortHash(fields.chain)}</span>
          </p>
          <p className="row">
            <span className="small">Time</span>
            <span>{fields.issuedAt}</span>
          </p>
          <p className="row">
            <span className="small">One-time code</span>
            <span className="mono">{fields.nonce}</span>
          </p>
        </div>
      )}
      <details className="dev">
        <summary>See the raw request, or paste your own</summary>
        <p className="small">This is the exact request a site sends. Your wallet turns it into the plain summary above.</p>
        <textarea className="mono" value={input} onChange={(e) => setInput(e.target.value)} rows={10} spellCheck={false} />
        <button className="primary" onClick={() => (setMine(false), read(input))}>
          Read it
        </button>
        <button className="link" onClick={() => (setInput(sample), setMine(false), read(sample))}>
          Reset to the example
        </button>
      </details>
    </section>
  );
}
