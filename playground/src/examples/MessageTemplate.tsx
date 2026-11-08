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
        See exactly what your wallet is asked to sign when it proves a wallet is yours: a short, readable message (who is asking, which wallet, when) and a transaction shaped so it can never
        move your coins. Change the fields and watch it update.
      </p>
      <p className="small dev-note">
        For developers: built in your browser with <code>message</code> and <code>proofTemplate</code> from <code>ckb-ward/wallet</code>.
      </p>
      <p className="try">
        <strong>Try it.</strong> Change any field below and the message updates as you type.
      </p>
      <div className="card">
        <label>
          Website asking
          <input value={domain} onChange={(e) => setDomain(e.target.value)} />
        </label>
        <label>
          Account
          <input value={account} onChange={(e) => setAccount(e.target.value)} />
        </label>
        <label>
          Time
          <input value={issuedAt} onChange={(e) => setIssuedAt(e.target.value)} />
          <button className="link" onClick={() => setIssuedAt(new Date().toISOString().replace(/\.\d+Z$/, "Z"))}>
            Use now
          </button>
        </label>
        <label>
          One-time code
          <input value={nonce} onChange={(e) => setNonce(e.target.value)} />
        </label>
        <p className="small">
          Wallet: {lockKind(lock)} · <span className="mono">{shortHash(lock.hash())}</span>
          {connected ? " (your connected wallet)" : " (a sample; connect a wallet to use yours)"}
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
              <strong>Why this can never take your coins</strong>
            </p>
            <p className="small">
              The signature is shaped like a transaction, but it spends from a made-up place that holds no real coins. So even if someone copied this signature, it could never move anything.
            </p>
            <details className="dev">
              <summary>For developers</summary>
              <p className="small">The one input points at an out point derived from the message, so no live cell can match it:</p>
              <p className="mono small">{shortHash(out.txHash)} : 0xffffffff</p>
              <p className="small">The whole transaction the wallet signs:</p>
              <pre className="shows mono template">{out.template}</pre>
            </details>
          </div>
        </>
      )}
    </section>
  );
}
