import { useCallback, useEffect, useMemo, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";

type Totals = Record<string, { weight: string; accounts: number }>;
type Vote = { account: string; choice: string; weight: string; locks: { lockHash: string; weight: string; counted: boolean; reason: string }[] };
type Poll = { id: number; snapshotBlock: number; totals: Totals; votes: Vote[] };
type State = {
  now: number;
  domain: string;
  phase: "bind" | "vote";
  voteOpensAt: number;
  closesAt: number;
  cooldownMinutes: number;
  question: string;
  options: string[];
  poll: Poll | null;
  last: Poll | null;
  me: { account: string; myVote: string | null } | null;
};
type Binding = { lock_hash: string; account: string; bound_at: string; bound_block: number; moved_from: string | null };

const REPO = "https://github.com/LusoCryptoLabs/ckb-ward";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.reason ?? `HTTP ${res.status}`);
  return json as T;
}

const ckb = (shannons: string | bigint) => {
  const n = BigInt(shannons);
  const whole = n / 100_000_000n;
  const cents = (n % 100_000_000n) / 1_000_000n;
  return `${whole.toLocaleString("en")}${cents ? `.${cents.toString().padStart(2, "0")}` : ""} CKB`;
};
const short = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** A plain name for the lock a wallet uses, from its code hash (testnet). */
function lockKind(lock: ccc.Script): string {
  const code = lock.codeHash;
  if (code === "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb") {
    const flag = lock.args.slice(2, 4);
    const mode = { "00": "CKB key", "01": "Ethereum", "12": "Ethereum", "04": "Bitcoin", "05": "Dogecoin", "06": "multisig" }[flag];
    return `Omnilock${mode ? `, ${mode} mode` : ""}`;
  }
  const known: Record<string, string> = {
    "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8": "secp256k1",
    "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac": "JoyID",
    "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356": "anyone-can-pay",
    "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8": "multisig",
    "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e": "Cellula smart account",
  };
  return known[code] ?? `lock ${short(code)}`;
}

export function App() {
  const { open, disconnect, wallet } = ccc.useCcc();
  const signer = ccc.useSigner();
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());
  const [skew, setSkew] = useState(0);
  const [lock, setLock] = useState<ccc.Script | null>(null);
  const [address, setAddress] = useState("");
  const [weight, setWeight] = useState<{ block: string; weight: string; deposits: number; withdrawing: number } | null>(null);
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [mine, setMine] = useState<{ account: string | null; bindings: Binding[] }>({ account: null, bindings: [] });
  const [all, setAll] = useState<Binding[]>([]);
  const [myVote, setMyVote] = useState<{ weight: string; locks: Vote["locks"] } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<State>("/api/state");
      setState(s);
      setSkew(s.now - Date.now());
      setMine(await api("/api/mine"));
      setAll((await api<{ bindings: Binding[] }>("/api/bindings")).bindings);
    } catch {
      /* the next tick tries again */
    }
  }, []);

  useEffect(() => {
    refresh();
    const a = setInterval(refresh, 10_000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    return () => (clearInterval(a), clearInterval(b));
  }, [refresh]);

  useEffect(() => {
    setLock(null);
    setWeight(null);
    setAddress("");
    if (!signer) return;
    (async () => {
      const obj = await signer.getRecommendedAddressObj();
      setLock(obj.script);
      setAddress(obj.toString());
      setAccount((a) => a || `user-${obj.script.args.slice(-6)}`);
      try {
        setWeight(await api("/api/weight", { lock: obj.script }));
      } catch {
        /* shown as unknown */
      }
    })();
  }, [signer]);

  const serverNow = now + skew;
  const phaseLeft = state ? (state.phase === "bind" ? state.voteOpensAt : state.closesAt) - serverNow : 0;
  useEffect(() => {
    if (state && phaseLeft < -1500) refresh();
  }, [state, phaseLeft, refresh]);

  const bind = async () => {
    if (!signer || !lock) return;
    setNote(null);
    try {
      setBusy("Asking the demo for a message…");
      const n = await api<{ nonce: string; message: string; template: unknown }>("/api/nonce", { account, lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } });
      setBusy("Sign in your wallet. It is a proof: it can never land on chain, and nothing leaves your account.");
      const signed = await signer.signTransaction(ccc.Transaction.from(n.template as ccc.TransactionLike));
      setBusy("Checking the proof: the demo runs your lock as a node would…");
      const r = await api<{ account: string; cycles: string; movedFrom: string | null }>("/api/bind", { nonce: n.nonce, tx: JSON.parse(signed.stringify()) });
      setNote({ ok: true, text: `Bound to ${r.account}. Your lock accepted the proof in ${Number(r.cycles).toLocaleString("en")} cycles.${r.movedFrom ? ` It was bound to ${r.movedFrom}: it carries no weight for ${state?.cooldownMinutes} minutes (rule 6).` : ""}` });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
      refresh();
    }
  };

  const unbind = async (lockHash: string) => {
    try {
      await api("/api/unbind", { lockHash });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    }
    refresh();
  };

  const vote = async (choice: string) => {
    setNote(null);
    try {
      setBusy("Reading your weight at the snapshot block…");
      const r = await api<{ weight: string; locks: Vote["locks"] }>("/api/vote", { choice });
      setMyVote(r);
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy("");
      refresh();
    }
  };

  const poll = state?.phase === "vote" ? state.poll : state?.last;
  const voting = state?.phase === "vote";
  /** Too close to the vote to sign and be checked before binding freezes. */
  const closing = !voting && phaseLeft < 45_000;
  const lockBound = useMemo(() => (lock ? all.find((b) => b.lock_hash === lock.hash()) : undefined), [all, lock]);

  return (
    <main>
      <header>
        <p className="tag">Testnet demo</p>
        <h1>Prove your CKB lock, vote with your Nervos DAO deposits</h1>
        <p>
          Any wallet signs one proof that can never land on chain. The demo runs your lock on it, as a CKB node would, and binds the lock to an account. In each vote, the
          Nervos DAO deposits under your bound locks count, read at one snapshot block. Built on <a href={REPO}>Ward</a>.
        </p>
      </header>

      <section className={`clock ${voting ? "vote" : "bind"}`}>
        {state ? (
          voting ? (
            <>
              <strong>Vote open</strong> · snapshot block {state.poll?.snapshotBlock.toLocaleString("en")} · closes in {clock(phaseLeft)}
              <span>Binding is frozen while a vote is open.</span>
            </>
          ) : (
            <>
              <strong>Binding open</strong> · the next vote opens in {clock(phaseLeft)}
              <span>Bind now: a binding counts only when it was made before the vote's snapshot block.</span>
            </>
          )
        ) : (
          "Loading…"
        )}
      </section>

      <section>
        <h2>1. Your wallet</h2>
        {signer && lock ? (
          <div className="card">
            <p>
              <strong>{wallet?.name ?? "Wallet"}</strong> · {lockKind(lock)}
            </p>
            <p className="mono">{short(address)}</p>
            <p>
              Nervos DAO deposits now:{" "}
              {weight ? `${ckb(weight.weight)} in ${weight.deposits} deposit${weight.deposits === 1 ? "" : "s"}${weight.withdrawing ? ` (${weight.withdrawing} withdrawing, not counted)` : ""}` : "reading…"}
            </p>
            {lockBound && <p className="ok">This lock is bound to {lockBound.account}.</p>}
            <button className="link" onClick={disconnect}>
              Use another wallet
            </button>
          </div>
        ) : (
          <button onClick={open}>Connect a wallet</button>
        )}
        <p className="small">Cellula, JoyID, MetaMask, UniSat, OKX, UTXO Global and the other wallets CCC connects, on testnet. With no deposit, your vote counts with weight 0.</p>
      </section>

      <section>
        <h2>2. Bind it to an account</h2>
        <label>
          Account name on this demo
          <input value={account} onChange={(e) => setAccount(e.target.value.trim())} maxLength={64} placeholder="your name here" />
        </label>
        <button disabled={!signer || !lock || !!busy || voting || closing || !account} onClick={bind}>
          Prove and bind
        </button>
        {voting && <p className="small">Binding reopens when the vote closes.</p>}
        {closing && <p className="small">The vote opens in {clock(phaseLeft)}, too soon to sign and be checked. Binding reopens when it closes.</p>}
        {mine.account && (
          <div className="card">
            <p>
              You are <strong>{mine.account}</strong> on this browser.
            </p>
            {mine.bindings.map((b) => (
              <p key={b.lock_hash} className="row">
                <span className="mono">{short(b.lock_hash)}</span>
                <span>block {b.bound_block.toLocaleString("en")}</span>
                <button className="link" disabled={voting} onClick={() => unbind(b.lock_hash)}>
                  unbind
                </button>
              </p>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2>3. Vote</h2>
        <p className="question">{state?.question}</p>
        {voting ? (
          mine.account ? (
            <div className="choices">
              {state?.options.map((o) => (
                <button key={o} className={state?.me?.myVote === o ? "chosen" : ""} disabled={!!busy} onClick={() => vote(o)}>
                  {o}
                </button>
              ))}
            </div>
          ) : (
            <p className="small">Bind a lock before the next vote opens to take part.</p>
          )
        ) : (
          <p className="small">The vote opens in {clock(phaseLeft)}. Each lock counts once, whichever account holds it.</p>
        )}
        {myVote && (
          <div className="card">
            <p>Your weight: {ckb(myVote.weight)}</p>
            {myVote.locks.map((l) => (
              <p key={l.lockHash} className="small">
                <span className="mono">{short(l.lockHash)}</span> {l.counted ? ckb(l.weight) : "not counted"}: {l.reason}
              </p>
            ))}
          </div>
        )}
        {poll && (
          <div className="card">
            <p>
              <strong>{voting ? "This vote so far" : "Last vote"}</strong> · snapshot block {poll.snapshotBlock.toLocaleString("en")}
            </p>
            {state?.options.map((o) => (
              <p key={o} className="row">
                <span>{o}</span>
                <span>{ckb(poll.totals[o]?.weight ?? "0")}</span>
                <span>{poll.totals[o]?.accounts ?? 0} account(s)</span>
              </p>
            ))}
          </div>
        )}
      </section>

      {busy && <p className="busy">{busy}</p>}
      {note && <p className={note.ok ? "note ok" : "note bad"}>{note.text}</p>}

      <section>
        <h2>Bindings, public (rule 9)</h2>
        {all.length === 0 ? (
          <p className="small">None yet.</p>
        ) : (
          all.map((b) => (
            <p key={b.lock_hash} className="row small">
              <span className="mono">{short(b.lock_hash)}</span>
              <span>{b.account}</span>
              <span>block {b.bound_block.toLocaleString("en")}</span>
              {b.moved_from && <span>moved from {b.moved_from}</span>}
            </p>
          ))
        )}
      </section>

      <footer>
        <p>
          What this follows: the platform rules in section 9 of the <a href={`${REPO}/blob/main/docs/SPEC.md`}>Ward spec</a>. The demo issues each message itself, burns each nonce once, keeps one binding per lock
          (a moved one waits {state?.cooldownMinutes ?? 20} minutes), freezes binding during a vote, and counts only Nervos DAO deposits under the exact lock, live at the snapshot, from a proof whose cells were live then.
          Testnet only; nothing here moves funds. Source in <a href={`${REPO}/tree/main/demo`}>demo/</a>.
        </p>
      </footer>
    </main>
  );
}
