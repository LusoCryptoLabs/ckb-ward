import { useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { message, proofTemplate, readProof } from "../../../src/wallet.ts";
import { shortHash } from "../lib";

const CHAIN = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

type Fields = { domain: string; account: string; lockHash: string; chain: string; issuedAt: string; nonce: string };

export function ReadProof() {
  const sample = useMemo(() => {
    const lock = ccc.Script.from({ codeHash: SECP, hashType: "type", args: `0x${"ab".repeat(20)}` });
    const text = message({ domain: "dao.example", account: "alice", lock, chain: CHAIN, issuedAt: "2026-11-04T18:00:00Z", nonce: "demo-nonce" });
    return JSON.stringify(JSON.parse(proofTemplate(lock, text).stringify()), null, 2);
  }, []);
  const [input, setInput] = useState(sample);
  const [fields, setFields] = useState<Fields | null>(null);
  const [note, setNote] = useState("");

  const read = () => {
    setNote("");
    setFields(null);
    let tx: ccc.Transaction;
    try {
      tx = ccc.Transaction.from(JSON.parse(input));
    } catch {
      setNote("That is not a transaction in JSON.");
      return;
    }
    const lock = tx.inputs[0]?.cellOutput?.lock;
    if (!lock) {
      setNote("The transaction's input carries no lock, so there is nothing to check it against.");
      return;
    }
    const f = readProof(tx, lock);
    if (!f) {
      setNote("Not a proof: it is not the template for this lock and the message in its output.");
      return;
    }
    setFields(f as Fields);
  };

  return (
    <section>
      <p className="lead">
        How a wallet knows a request is a proof, not a transfer, so it can show the domain asking for it. This runs entirely in your browser, with <code>readProof</code> from{" "}
        <code>ckb-ward/wallet</code>. No server.
      </p>
      <div className="card">
        <label>
          A proof transaction, in JSON (the sample is a proof for a sample lock)
          <textarea className="mono" value={input} onChange={(e) => setInput(e.target.value)} rows={10} spellCheck={false} />
        </label>
        <button className="primary" onClick={read}>
          Read it
        </button>
        <button className="link" onClick={() => (setInput(sample), setFields(null), setNote(""))}>
          Reset to the sample
        </button>
      </div>
      {note && <p className="note bad">{note}</p>}
      {fields && (
        <div className="card">
          <p className="ok">
            <strong>✓ This is a proof request.</strong>
          </p>
          <p className="small">A wallet shows the domain next to the origin of the site that asked, and the account, instead of a transfer:</p>
          <p className="row">
            <span className="small">Domain</span>
            <span>{fields.domain}</span>
          </p>
          <p className="row">
            <span className="small">Account</span>
            <span className="mono">{fields.account}</span>
          </p>
          <p className="row">
            <span className="small">Lock</span>
            <span className="mono">{shortHash(fields.lockHash)}</span>
          </p>
          <p className="row">
            <span className="small">Chain</span>
            <span className="mono">{shortHash(fields.chain)}</span>
          </p>
          <p className="row">
            <span className="small">Issued at</span>
            <span>{fields.issuedAt}</span>
          </p>
          <p className="row">
            <span className="small">Nonce</span>
            <span className="mono">{fields.nonce}</span>
          </p>
        </div>
      )}
    </section>
  );
}
