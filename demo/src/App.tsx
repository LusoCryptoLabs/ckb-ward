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
  cycleMinutes?: number;
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

/** The server's answers, in the words of someone voting. */
function plainError(reason: string): string {
  const table: [RegExp, string][] = [
    [/binding is frozen|vote is open/i, "Voting is open, so sign-up is paused. Try again when it ends."],
    [/belongs to someone else/i, "That name is taken. Pick another name."],
    [/nonce already used/i, "That signature was already used. Sign again."],
    [/not the proof template|unknown nonce|issued|expired|too old/i, "The signature did not match the request. Sign again."],
    [/lock exited|opens without|lock also opens/i, "Your wallet's signature did not check out. Sign again with this wallet."],
    [/not live/i, "Part of your wallet changed on the network. Reconnect and sign again."],
    [/too many requests/i, "Too many tries. Wait a minute and try again."],
    [/node did not answer|could not answer/i, "The test network did not answer in time. Try again."],
    [/no vote is open/i, "Voting has not started yet."],
    [/bind a lock first/i, "Sign up first, before voting starts."],
    [/reject|refus|cancel|denied|closed/i, "You cancelled in your wallet."],
  ];
  return table.find(([re]) => re.test(reason))?.[1] ?? reason;
}

/** Why one wallet counts as it does in a vote, in plain words. */
function plainCount(l: { lockHash: string; weight: string; counted: boolean; reason: string }, cooldown: number): string {
  const w = `Wallet ${short(l.lockHash)}`;
  if (l.counted) return `${w}: ${ckb(l.weight)} in the Nervos DAO when voting opened${/withdrawing/.test(l.reason) ? " (a withdrawal in progress does not count)" : ""}.`;
  if (/cooldown/.test(l.reason)) return `${w}: it was signed up under another name less than ${cooldown} minutes before voting, so it does not count yet.`;
  if (/snapshot block/.test(l.reason)) return `${w}: signed up after voting opened, so it counts from the next vote.`;
  if (/not live/.test(l.reason)) return `${w}: the wallet changed on the network since it signed up. Sign up again.`;
  return `${w}: ${l.reason}`;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
      setBusy("Preparing what your wallet will sign…");
      const n = await api<{ nonce: string; message: string; template: unknown }>("/api/nonce", { account, lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } });
      setBusy("Sign in your wallet. It is not a payment: nothing leaves your wallet.");
      const signed = await signer.signTransaction(ccc.Transaction.from(n.template as ccc.TransactionLike));
      setBusy("Checking your signature…");
      const r = await api<{ account: string; cycles: string; movedFrom: string | null }>("/api/bind", { nonce: n.nonce, tx: JSON.parse(signed.stringify()) });
      setNote({ ok: true, text: `Signed up as ${r.account}. Your wallet proved it is yours.${r.movedFrom ? ` It was signed up as ${r.movedFrom} before, so it starts counting for you in ${state?.cooldownMinutes} minutes.` : ""}` });
    } catch (e) {
      setNote({ ok: false, text: plainError((e as Error).message) });
    } finally {
      setBusy("");
      refresh();
    }
  };

  const unbind = async (lockHash: string) => {
    try {
      await api("/api/unbind", { lockHash });
    } catch (e) {
      setNote({ ok: false, text: plainError((e as Error).message) });
    }
    refresh();
  };

  const vote = async (choice: string) => {
    setNote(null);
    try {
      setBusy("Counting your deposits…");
      const r = await api<{ weight: string; locks: Vote["locks"] }>("/api/vote", { choice });
      setMyVote(r);
    } catch (e) {
      setNote({ ok: false, text: plainError((e as Error).message) });
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
        <p className="tag">Testnet demo · no real money</p>
        <h1>Vote with your Nervos DAO deposits, from any wallet</h1>
        <p>
          Connect your wallet and sign once to show it is yours. Nothing is sent and nothing leaves your wallet. Then vote: the CKB you have deposited in the Nervos DAO
          decides how much your vote counts. This is a test vote on the CKB test network: it decides nothing, and real CKB is never used.
        </p>
        <p className="need">
          <strong>How to take part:</strong> connect and sign up now, come back when voting opens, then press Yes or No.
          <br />
          <strong>What you need:</strong> only a wallet. MetaMask, UniSat and OKX work as they are; JoyID and Cellula open their test version, where you may need to log in or create an account.
          No test CKB needed: without a test deposit your vote is recorded but weighs 0 CKB.
        </p>
      </header>

      <section className={`clock ${voting ? "vote" : "bind"}`}>
        {state ? (
          voting ? (
            <>
              <strong>Voting is open</strong> · ends in {clock(phaseLeft)}
              <span>Sign-up is paused until it ends, so no one can vote twice with the same deposit.</span>
            </>
          ) : (
            <>
              <strong>Sign-up is open</strong> · voting starts in {clock(phaseLeft)}
              <span>
                {mine.account
                  ? `You are signed up as ${mine.account}. Come back in ${clock(phaseLeft)} to vote, in this browser.`
                  : `Sign up before voting starts to take part. A test vote runs every ${state.cycleMinutes ?? 15} minutes; you can leave and come back in this browser.`}
              </span>
            </>
          )
        ) : (
          "Loading…"
        )}
      </section>

      <section>
        <h2>1. Connect your wallet</h2>
        {signer && lock ? (
          <div className="card">
            <p>
              <strong>{wallet?.name ?? "Wallet"}</strong> <span className="small">({lockKind(lock)})</span>
            </p>
            <p className="mono">{short(address)}</p>
            <p>
              In the Nervos DAO: {weight ? ckb(weight.weight) : "reading…"}
              {weight?.withdrawing ? " (a withdrawal in progress does not count)" : ""}
            </p>
            {lockBound && <p className="ok">Signed up as {lockBound.account}.</p>}
            <button className="link" onClick={disconnect}>
              Use another wallet
            </button>
          </div>
        ) : (
          <button onClick={open}>Connect a wallet</button>
        )}
        <p className="small">Works with Cellula, JoyID, MetaMask, UniSat, OKX, UTXO Global and more. Your wallet connects on the CKB test network.</p>
      </section>

      <section>
        <h2>2. Sign up with your wallet</h2>
        <label>
          Your name in this vote (any name; the public list below shows it and the time you signed up)
          <input value={account} onChange={(e) => setAccount(e.target.value.trim())} maxLength={64} placeholder="any name" />
        </label>
        <button disabled={!signer || !lock || !!busy || voting || closing || !account} onClick={bind}>
          Sign to prove it is yours
        </button>
        {!signer && <p className="small">Connect your wallet first (step 1).</p>}
        <p className="small">Your wallet asks you to sign a message that names this site and your name. It is not a payment: it can never be sent, and nothing leaves your wallet. Some wallets show it only as a code.</p>
        {voting && <p className="small">Sign-up reopens when voting ends, in {clock(phaseLeft)}.</p>}
        {closing && <p className="small">Voting starts in {clock(phaseLeft)}, too soon to finish signing up. Sign-up reopens after it.</p>}
        {mine.account && (
          <div className="card">
            <p>
              You are signed up as <strong>{mine.account}</strong> in this browser.
            </p>
            {mine.bindings.map((b) => (
              <p key={b.lock_hash} className="row small">
                <span>
                  Wallet {short(b.lock_hash)}, since {timeOf(b.bound_at)}
                </span>
                <button className="link" disabled={voting} onClick={() => unbind(b.lock_hash)}>
                  remove
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
            <>
              <div className="choices">
                {state?.options.map((o) => (
                  <button key={o} className={state?.me?.myVote === o ? "chosen" : ""} disabled={!!busy} onClick={() => vote(o)}>
                    {o}
                  </button>
                ))}
              </div>
              <p className="small">You can change your vote until voting ends.</p>
            </>
          ) : (
            <p className="small">To vote, sign up (steps 1 and 2) when this round ends, in {clock(phaseLeft)}. Yes and No buttons appear here in the next round.</p>
          )
        ) : (
          <p className="small">
            Voting starts in {clock(phaseLeft)}. {mine.account ? "Yes and No buttons appear here then." : "Sign up first (steps 1 and 2); Yes and No buttons appear here when voting opens."}
          </p>
        )}
        {myVote && (
          <div className="card">
            <p>Your vote counts as {ckb(myVote.weight)}.</p>
            {myVote.locks.map((l) => (
              <p key={l.lockHash} className="small">
                {plainCount(l, state?.cooldownMinutes ?? 20)}
              </p>
            ))}
          </div>
        )}
        {poll && poll.votes.length === 0 && <p className="small">{voting ? "No votes yet in this round." : "No one voted in the last round."}</p>}
        {poll && poll.votes.length > 0 && (
          <div className="card">
            <p>
              <strong>{voting ? "Results so far" : "Last vote"}</strong>
            </p>
            {state?.options.map((o) => {
              const n = poll.totals[o]?.accounts ?? 0;
              return (
                <p key={o} className="row">
                  <span>{o}</span>
                  <span>{ckb(poll.totals[o]?.weight ?? "0")}</span>
                  <span>
                    {n} {n === 1 ? "person" : "people"}
                  </span>
                </p>
              );
            })}
          </div>
        )}
      </section>

      {busy && <p className="busy">{busy}</p>}
      {note && <p className={note.ok ? "note ok" : "note bad"}>{note.text}</p>}

      <section>
        <h2>Who has signed up</h2>
        {all.length === 0 ? (
          <p className="small">No one yet.</p>
        ) : (
          all.map((b) => (
            <p key={b.lock_hash} className="row small">
              <span>{b.account}</span>
              <span>since {timeOf(b.bound_at)}</span>
              {b.moved_from && <span>moved from {b.moved_from}</span>}
            </p>
          ))
        )}
        <p className="small">The list is public, so anyone can check who takes part.</p>
      </section>

      <details className="how">
        <summary>How it works</summary>
        <p>
          What you sign is shaped like a payment that points at coins that do not exist, so the network can never accept it. The demo then checks your signature with the same
          program the network would use for your wallet. If it passes, the wallet is yours. This method is called <a href={REPO}>Ward</a>.
        </p>
        <p>
          Each vote counts the CKB deposited in the Nervos DAO at the moment voting opened. CKB you have started to withdraw does not count. Each wallet counts once. A wallet that moves to a
          new name waits {state?.cooldownMinutes ?? 20} minutes before it counts again, and sign-up pauses during a vote, so deposits cannot be moved between names to vote twice.
        </p>
        <p>
          For developers: these are the platform rules in section 9 of the <a href={`${REPO}/blob/main/docs/SPEC.md`}>Ward spec</a>, and the{" "}
          <a href={`${REPO}/tree/main/demo`}>source code</a> is open.
        </p>
      </details>
    </main>
  );
}
