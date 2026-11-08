import { useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { MAX_MESSAGE_BYTES, message, proofOutPoint, proofTemplate } from "../../../src/wallet.ts";
import { lockKind, shortHash, useWallet } from "../lib";

const CHAIN = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";

export function MessageTemplate() {
  const { lock: connected } = useWallet();
  const sample = useMemo(() => ccc.Script.from({ codeHash: SECP, hashType: "type", args: `0x${"ab".repeat(20)}` }), []);
  const lock = connected ?? sample;
  const [domain, setDomain] = useState("dao.example");
  const [account, setAccount] = useState("alice");
  const [nonce, setNonce] = useState("demo-nonce");
  const [issuedAt, setIssuedAt] = useState("2026-11-04T18:00:00Z");

  const out = useMemo(() => {
    try {
      const text = message({ domain, account, lock, chain: CHAIN, issuedAt, nonce });
      const bytes = ccc.bytesFrom(text, "utf8").length;
      const template = JSON.stringify(JSON.parse(proofTemplate(lock, text).stringify()), null, 2);
      const op = proofOutPoint(lock, text);
      return { text, bytes, template, txHash: op.txHash, error: "" };
    } catch (e) {
      return { text: "", bytes: 0, template: "", txHash: "", error: (e as Error).message };
    }
  }, [domain, account, nonce, issuedAt, lock]);

  return (
    <section>
      <p className="lead">
        What a proof is made of, built as you type, in your browser with <code>message</code> and <code>proofTemplate</code> from <code>ckb-ward/wallet</code>. The message names the platform,
        the account, the lock, the chain, the time and a single-use nonce. The template is a transaction that can never land.
      </p>
      <div className="card">
        <label>
          Domain
          <input value={domain} onChange={(e) => setDomain(e.target.value)} />
        </label>
        <label>
          Account
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
        <label>
          Issued at (RFC 3339 UTC)
          <input value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
          <button className="link" onClick={() => setIssuedAt(new Date().toISOString().replace(/\.\d+Z$/, "Z"))}>
            Use now
          </button>
        </label>
        <label>
          Nonce
          <input value={nonce} onChange={(e) => setNonce(e.target.value)} />
        </label>
        <p className="small">
          Lock: {lockKind(lock)} · <span className="mono">{shortHash(lock.hash())}</span>
          {connected ? " (your connected address)" : " (a sample lock; connect a wallet to use yours)"}
        </p>
      </div>
      {out.error ? (
        <p className="note bad">The library refuses this: {out.error}.</p>
      ) : (
        <>
          <div className="card">
            <p className="row">
              <strong>The message</strong>
              <span className="small">
                {out.bytes} of {MAX_MESSAGE_BYTES} bytes
              </span>
            </p>
            <pre className="shows mono">{out.text}</pre>
          </div>
          <div className="card">
            <p>
              <strong>The fake out point</strong>
            </p>
            <p className="small">The template's one input points here. Its tx hash is ckbhash of the tag, the lock hash and the message, so no real cell can ever have it:</p>
            <p className="mono small">
              {shortHash(out.txHash)} : 0xffffffff
            </p>
          </div>
          <div className="card">
            <p>
              <strong>The proof template</strong>
            </p>
            <p className="small">This is what the wallet signs, like any transaction. Cell deps and witnesses are the wallet's to fill.</p>
            <pre className="shows mono template">{out.template}</pre>
          </div>
        </>
      )}
    </section>
  );
}
