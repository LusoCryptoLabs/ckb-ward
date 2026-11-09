import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ccc } from "@ckb-ccc/connector-react";
import { useWallet } from "../lib";

type Totals = Record<string, { weight: string; accounts: number }>;
type LockCount = { lockHash: string; weight: string; counted: boolean; reason: string };
type Vote = { account: string; choice: string; weight: string; locks: LockCount[] };
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
type MyBinding = { lock_hash: string; lock: ccc.ScriptLike; bound_at: string; bound_block: number; moved_from: string | null };
type Weight = { block: string; weight: string; deposits: number; withdrawing: number };
/** One address of the connected wallet, with its Nervos DAO deposit once read. */
type Choice = { script: ccc.Script; address: string; weight: Weight | null };
/** A proof request fetched ahead, so a tap opens the wallet at once. */
type Prepared = { key: string; nonce: string; template: unknown; at: number };
type Stage = "" | "preparing" | "wallet" | "checking";

const REPO = "https://github.com/LusoCryptoLabs/ckb-ward";
/** A request is good for 10 minutes on the server; fetch a new one before that. */
const PREPARED_FOR_MS = 8 * 60_000;

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
/** An address cut the way the Cellula wallet cuts it, so the two screens match. */
const shortAddress = (a: string) => (a.length > 24 ? `${a.slice(0, 8)}…${a.slice(-12)}` : a);
const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const timeOf = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const OMNILOCK = "0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb";
const CELLULA = "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e";
const PW_LOCK = "0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63";
const JOYID = "0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac";

/** A plain name for the lock a wallet uses, from its code hash (testnet). */
function lockKind(lock: ccc.Script): string {
  if (lock.codeHash === OMNILOCK) {
    const mode = { "00": "CKB key", "01": "older Ethereum", "12": "Ethereum", "04": "Bitcoin", "05": "Dogecoin", "06": "multisig" }[lock.args.slice(2, 4)];
    return `Omnilock${mode ? `, ${mode} mode` : ""}`;
  }
  const known: Record<string, string> = {
    "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8": "secp256k1",
    [JOYID]: "JoyID",
    "0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356": "anyone-can-pay",
    "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8": "multisig",
    [CELLULA]: "Cellula smart account",
    [PW_LOCK]: "Portal Wallet",
  };
  return known[lock.codeHash] ?? `lock ${shortHash(lock.codeHash)}`;
}

/**
 * What the wallet shows when it signs, which the lock and CCC decide: a bare code for PW-lock and
 * older Omnilock, "CKB transaction: 0x…" for Omnilock's Ethereum mode, "CKB (Bitcoin Layer)
 * transaction: 0x…" for Bitcoin wallets, a page of its own for Cellula.
 */
function walletWillShow(lock: ccc.Script, wallet: string, domain: string): string {
  const flag = lock.codeHash === OMNILOCK ? lock.args.slice(2, 4) : "";
  const shaped = "It says transaction because the proof is shaped like one, but it spends coins that do not exist, so it can never go through.";
  if (lock.codeHash === CELLULA) return `Cellula opens a page that says “${domain} asks you to prove this wallet is yours”, with your name and this address.`;
  if (lock.codeHash === PW_LOCK || flag === "01")
    return `${wallet} opens a “Signature request” that shows only a code: 0x and 64 letters and digits. It may name Ethereum as the network. This page shows the same code while ${wallet} is open, so you can check they match.`;
  if (flag === "12") return `${wallet} shows “CKB transaction: 0x…” and may name Ethereum as the network. ${shaped} This page shows the same text while ${wallet} is open.`;
  if (flag === "04") return `${wallet} shows “CKB (Bitcoin Layer) transaction: 0x…”. ${shaped} This page shows the same text while ${wallet} is open.`;
  if (lock.codeHash === JOYID) return "JoyID opens and asks you to sign with your passkey.";
  return `${wallet} asks you to sign. It may call it a transaction or show a code.`;
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
    [/reject|refus|cancel|denied|closed/i, "You cancelled in your wallet. Nothing was signed."],
  ];
  return table.find(([re]) => re.test(reason))?.[1] ?? reason;
}

/** Why one address counts as it does in a vote, in plain words. */
function plainCount(l: LockCount, label: string, cooldown: number): string {
  if (l.counted) return `${label}: ${ckb(l.weight)} in the Nervos DAO when voting opened${/withdrawing/.test(l.reason) ? " (a withdrawal in progress does not count)" : ""}.`;
  if (/cooldown/.test(l.reason)) return `${label}: it moved to this name less than ${cooldown} minutes before voting, so it counts from the next vote.`;
  if (/snapshot block/.test(l.reason)) return `${label}: signed up after voting opened, so it counts from the next vote.`;
  if (/not live/.test(l.reason)) return `${label}: the wallet changed on the network since it signed up. Sign up again.`;
  return `${label}: ${l.reason}`;
}

/** The text a wallet is asked to sign, with its first and last characters set apart to compare. */
function Shows({ text }: { text: string }) {
  const code = /^0x[0-9a-f]{64}$/i.test(text) ? { head: text.slice(0, 8), mid: text.slice(8, -6), tail: text.slice(-6), prefix: "" } : null;
  const inText = !code && /0x[0-9a-f]{64}/i.exec(text);
  if (code)
    return (
      <p className="shows mono">
        <b>{code.head}</b>
        {code.mid}
        <b>{code.tail}</b>
      </p>
    );
  if (inText) {
    const h = inText[0];
    return (
      <p className="shows mono">
        {text.slice(0, inText.index)}
        <b>{h.slice(0, 8)}</b>
        {h.slice(8, -6)}
        <b>{h.slice(-6)}</b>
        {text.slice(inText.index + h.length)}
      </p>
    );
  }
  return <p className="shows mono">{text}</p>;
}

export function Voting() {
  const { open, disconnect, wallet, client } = ccc.useCcc();
  const signer = ccc.useSigner();
  const { network } = useWallet();
  const [state, setState] = useState<State | null>(null);
  const [now, setNow] = useState(Date.now());
  const [skew, setSkew] = useState(0);
  const [lock, setLock] = useState<ccc.Script | null>(null);
  const [address, setAddress] = useState("");
  const [weight, setWeight] = useState<Weight | null>(null);
  const [choices, setChoices] = useState<Choice[]>([]);
  const chosenByHand = useRef(false);
  const nameTouched = useRef(false);
  const lockHashRef = useRef("");
  const [account, setAccount] = useState("");
  const [mine, setMine] = useState<{ account: string | null; bindings: MyBinding[] }>({ account: null, bindings: [] });
  const [all, setAll] = useState<Binding[]>([]);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [prepError, setPrepError] = useState("");
  const [stage, setStage] = useState<Stage>("");
  const [walletShows, setWalletShows] = useState<string | null>(null);
  const [bindNote, setBindNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [changing, setChanging] = useState(false);
  const [voteBusy, setVoteBusy] = useState(false);
  const [voteNote, setVoteNote] = useState("");
  const [myVote, setMyVote] = useState<{ choice: string; weight: string; locks: LockCount[] } | null>(null);
  const [copied, setCopied] = useState(false);
  const step2 = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api<State>("/api/vote/state");
      setState(s);
      setSkew(s.now - Date.now());
      setMine(await api("/api/vote/mine"));
      setAll((await api<{ bindings: Binding[] }>("/api/vote/bindings")).bindings);
    } catch {
      /* the next tick tries again */
    }
  }, []);

  useEffect(() => {
    refresh();
    const a = setInterval(refresh, 10_000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    // Back from the wallet's window: show what changed at once, not at the next tick.
    const seen = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", seen);
    return () => (clearInterval(a), clearInterval(b), document.removeEventListener("visibilitychange", seen));
  }, [refresh]);

  const choose = useCallback((c: Choice) => {
    lockHashRef.current = c.script.hash();
    setLock(c.script);
    setAddress(c.address);
    setWeight(c.weight);
  }, []);

  // A wallet can hold more than one address: MetaMask through CCC has an Omnilock address and the
  // PW-lock address Portal Wallet used. List them all, read each one's deposit, and start with the
  // one that holds the most, or the wallet's own pick when none holds any.
  useEffect(() => {
    setLock(null);
    setWeight(null);
    setAddress("");
    setChoices([]);
    setBindNote(null);
    chosenByHand.current = false;
    if (!signer) return;
    let gone = false;
    (async () => {
      const first = await signer.getRecommendedAddressObj();
      const all = await signer.getAddressObjs().catch(() => [first]);
      const seen = new Set<string>();
      const picked = [first, ...all].filter((o) => o.script.codeHash !== PW_LOCK);
      const list: Choice[] = (picked.length ? picked : [first])
        .filter((o) => !seen.has(o.script.hash()) && !!seen.add(o.script.hash()))
        .slice(0, 4)
        .map((o) => ({ script: o.script, address: o.toString(), weight: null }));
      if (gone) return;
      setChoices(list);
      choose(list[0]);
      const weights = await Promise.all(list.map((c) => api<Weight>("/api/weight", { lock: c.script }).catch(() => null)));
      if (gone) return;
      const read = list.map((c, i) => ({ ...c, weight: weights[i] }));
      setChoices(read);
      const most = read.reduce((m, c, i) => (BigInt(c.weight?.weight ?? 0) > BigInt(read[m].weight?.weight ?? 0) ? i : m), 0);
      if (!chosenByHand.current) choose(read[most]);
      else setWeight((w) => read.find((c) => c.script.hash() === lockHashRef.current)?.weight ?? w);
    })();
    return () => {
      gone = true;
    };
  }, [signer, choose]);

  const serverNow = now + skew;
  const phaseLeft = state ? (state.phase === "bind" ? state.voteOpensAt : state.closesAt) - serverNow : 0;
  useEffect(() => {
    if (state && phaseLeft < -1500) refresh();
  }, [state, phaseLeft, refresh]);

  const voting = state?.phase === "vote";
  /** Too close to the vote to sign and be checked before binding freezes. */
  const closing = !voting && phaseLeft < 45_000;
  const cooldownMs = (state?.cooldownMinutes ?? 20) * 60_000;
  const lockBound = useMemo(() => (lock ? all.find((b) => b.lock_hash === lock.hash()) : undefined), [all, lock]);
  const boundHere = !!lockBound && lockBound.account === mine.account;

  // The name: the one this browser signed up with, else one made from the address. Never a new
  // name over an address already signed up here, which would move it and restart its wait.
  useEffect(() => {
    if (!lock || nameTouched.current) return;
    setAccount(mine.account ?? `user-${lock.args.slice(-6)}`);
  }, [lock, mine.account]);

  /** This browser's addresses, by lock hash, to name them instead of showing hashes. */
  const myAddresses = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of choices) m.set(c.script.hash(), c.address);
    for (const b of mine.bindings) {
      try {
        if (!m.has(b.lock_hash)) m.set(b.lock_hash, ccc.Address.fromScript(b.lock, client).toString());
      } catch {
        /* an address that cannot be written: the hash below */
      }
    }
    return m;
  }, [choices, mine.bindings, client]);
  const label = (lockHash: string) => {
    const a = myAddresses.get(lockHash);
    return a ? `Address ${shortAddress(a)}` : `Wallet ${shortHash(lockHash)}`;
  };

  // Fetch the proof request as soon as the wallet and the name are known, so the tap goes straight
  // to the wallet (a phone browser can block a wallet window opened long after the tap).
  const prepKey = lock && account ? `${lock.hash()}|${account}` : "";
  const minute = Math.floor(now / 60_000);
  useEffect(() => {
    if (!signer || !lock || !prepKey || voting || closing || stage || (boundHere && !changing)) return;
    if (prepared?.key === prepKey && Date.now() - prepared.at < PREPARED_FOR_MS) return;
    let gone = false;
    const t = setTimeout(async () => {
      try {
        const n = await api<{ nonce: string; template: unknown }>("/api/vote/nonce", { account, lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } });
        if (!gone) (setPrepared({ key: prepKey, nonce: n.nonce, template: n.template, at: Date.now() }), setPrepError(""));
      } catch (e) {
        if (!gone) (setPrepared(null), setPrepError(plainError((e as Error).message)));
      }
    }, 500);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [signer, lock, account, prepKey, voting, closing, stage, prepared, minute, boundHere, changing]);
  useEffect(() => setPrepError(""), [prepKey]);

  const bind = async () => {
    if (!signer || !lock) return;
    setBindNote(null);
    setWalletShows(null);
    // See what the wallet is handed: CCC's EVM and Bitcoin signers pass the exact text through
    // signMessageRaw, so the page can show it beside the wallet's own screen.
    const s = signer as unknown as { signMessageRaw?: (m: string | ccc.BytesLike) => Promise<string> };
    const own = Object.prototype.hasOwnProperty.call(s, "signMessageRaw");
    const original = s.signMessageRaw;
    if (typeof original === "function")
      s.signMessageRaw = (m) => {
        setWalletShows(typeof m === "string" ? m : ccc.hexFrom(m));
        return original.call(signer, m);
      };
    try {
      let n = prepared?.key === prepKey && Date.now() - prepared.at < PREPARED_FOR_MS ? prepared : null;
      if (!n) {
        setStage("preparing");
        const fresh = await api<{ nonce: string; template: unknown }>("/api/vote/nonce", { account, lock: { codeHash: lock.codeHash, hashType: lock.hashType, args: lock.args } });
        n = { key: prepKey, nonce: fresh.nonce, template: fresh.template, at: Date.now() };
      }
      setStage("wallet");
      const signed = await signer.signTransaction(ccc.Transaction.from(n.template as ccc.TransactionLike));
      setStage("checking");
      setPrepared(null);
      const r = await api<{ account: string; cycles: string; movedFrom: string | null }>("/api/vote/bind", { nonce: n.nonce, tx: JSON.parse(signed.stringify()) });
      // The done card below says it, with the name; a second line would repeat it.
      void r;
      setChanging(false);
      nameTouched.current = false;
    } catch (e) {
      setPrepared(null);
      setBindNote({ ok: false, text: plainError((e as Error).message) });
    } finally {
      if (own) s.signMessageRaw = original;
      else delete s.signMessageRaw;
      setStage("");
      setWalletShows(null);
      await refresh();
      step2.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  };

  const unbind = async (lockHash: string) => {
    try {
      await api("/api/vote/unbind", { lockHash });
    } catch (e) {
      setBindNote({ ok: false, text: plainError((e as Error).message) });
    }
    refresh();
  };

  const vote = async (choice: string) => {
    setVoteNote("");
    setVoteBusy(true);
    try {
      const r = await api<{ weight: string; locks: LockCount[] }>("/api/vote/cast", { choice });
      setMyVote({ choice, ...r });
    } catch (e) {
      setVoteNote(plainError((e as Error).message));
    } finally {
      setVoteBusy(false);
      refresh();
    }
  };

  const poll = voting ? state?.poll : state?.last;
  const walletName = wallet?.name ?? "Your wallet";
  const myChoice = state?.me?.myVote ?? null;
  const bindLabel = { "": "Sign to prove it is yours", preparing: "Preparing…", wallet: `Waiting for ${walletName}…`, checking: "Checking your signature…" }[stage];
  const movedAt = lockBound?.moved_from ? Date.parse(lockBound.bound_at) + cooldownMs : 0;
  const moving = !!lockBound && lockBound.account !== account;

  return (
    <>
      <p className="lead">
        A community can let every member vote with the CKB they hold in the Nervos DAO, from any wallet. Prove a wallet with one signature to sign up, then vote. The CKB you have in the Nervos DAO
        decides how much your vote counts. Nothing is sent and nothing is spent. This runs on testnet, so nothing here is real.
      </p>

      {network !== "testnet" ? (
        <div className="card">
          <p>
            <strong>DAO voting runs on the test network.</strong> Switch to <strong>testnet</strong> at the top of the page to try it. The vote counts testnet Nervos DAO deposits, so nothing here is real.
          </p>
        </div>
      ) : (
      <>
      <section className={`clock ${voting ? "vote" : "bind"}`} aria-live="polite">
        {state ? (
          voting ? (
            <>
              <strong>Voting is open</strong> · ends in {clock(phaseLeft)}
              <span>Sign-up is paused until it ends, so no one can vote twice with the same deposit.</span>
            </>
          ) : (
            <>
              <strong>Sign-up is open</strong> · voting starts in {clock(phaseLeft)}
              <span>{mine.account ? `You are signed up as ${mine.account}. Keep this page open, or come back in this browser.` : `A test vote runs every ${state.cycleMinutes ?? 15} minutes.`}</span>
            </>
          )
        ) : (
          "Loading…"
        )}
      </section>

      <section className="step">
        <h2>
          <span className={`num ${signer && lock ? "done" : ""}`}>{signer && lock ? "✓" : "1"}</span> Connect your wallet
        </h2>
        {signer && lock ? (
          <div className="card">
            <p className="row">
              <strong>{walletName}</strong>
              <span className="small">{lockKind(lock)}</span>
            </p>
            <p className="row">
              <span className="mono">{shortAddress(address)}</span>
              <button
                className="copy"
                onClick={() => {
                  navigator.clipboard?.writeText(address).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)), () => {});
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </p>
            <p className="big">
              {weight ? ckb(weight.weight) : "Reading…"} <span className="small">in the Nervos DAO</span>
            </p>
            {weight?.withdrawing ? <p className="small">A withdrawal in progress does not count.</p> : null}
            {choices.length > 1 && (
              <fieldset className="pick">
                <legend className="small">This wallet has {choices.length} addresses. The one with the most in the DAO is chosen; you can pick another.</legend>
                {choices.map((c) => (
                  <label key={c.script.hash()}>
                    <input
                      type="radio"
                      name="address"
                      checked={lock?.hash() === c.script.hash()}
                      disabled={!!stage}
                      onChange={() => {
                        chosenByHand.current = true;
                        choose(c);
                      }}
                    />
                    <span>
                      <strong>{c.weight ? ckb(c.weight.weight) : "Reading…"}</strong> in the DAO
                      <br />
                      <span className="small">
                        {lockKind(c.script)} · <span className="mono">{shortAddress(c.address)}</span>
                      </span>
                    </span>
                  </label>
                ))}
              </fieldset>
            )}
            <button className="link" disabled={!!stage} onClick={disconnect}>
              Use another wallet
            </button>
          </div>
        ) : (
          <>
            <button onClick={open}>Connect a wallet</button>
            <p className="small">
              Cellula, JoyID, MetaMask, UniSat, OKX, UTXO Global and more. JoyID and Cellula open their test version, where you may need to log in or create an account. No test CKB
              needed: without a deposit your vote counts 0 CKB.
            </p>
          </>
        )}
      </section>

      <section className="step" ref={step2}>
        <h2>
          <span className={`num ${boundHere && !changing ? "done" : ""}`}>{boundHere && !changing ? "✓" : "2"}</span> Prove it is yours
        </h2>
        {!signer || !lock ? (
          <p className="small">After you connect, you sign once here. It is not a payment and costs nothing.</p>
        ) : boundHere && !changing ? (
          <div className="card">
            <p className="ok">
              <strong>Signed up as {lockBound!.account}</strong> with this address.
            </p>
            {movedAt > serverNow ? (
              <p className="small">
                It counts from {timeOf(movedAt)}: it moved here from {lockBound!.moved_from}, and an address that changes name waits {state?.cooldownMinutes ?? 20} minutes.
              </p>
            ) : (
              <p className="small">{voting ? "It counts in this vote." : `Its deposit counts in the vote that starts in ${clock(phaseLeft)}.`}</p>
            )}
            <p className="row small">
              <button className="link" disabled={voting} onClick={() => unbind(lockBound!.lock_hash)}>
                Remove it
              </button>
              <button className="link" disabled={voting} onClick={() => (setChanging(true), setBindNote(null))}>
                Use another name
              </button>
            </p>
          </div>
        ) : (
          <div className="card">
            <label>
              Your name in this vote (the public list below shows it)
              <input
                value={account}
                disabled={!!stage}
                onChange={(e) => {
                  nameTouched.current = true;
                  setAccount(e.target.value.trim());
                }}
                maxLength={64}
                placeholder="any name"
              />
            </label>
            {prepError && !stage && <p className="note bad">{prepError}</p>}
            {moving && (
              <p className="warn">
                This address is signed up as {lockBound!.account}. Signing it up as {account || "a new name"} moves it, and it then waits {state?.cooldownMinutes ?? 20} minutes
                before it counts{!voting && phaseLeft < cooldownMs ? `: it would count 0 in the vote that starts in ${clock(phaseLeft)}` : ""}.
              </p>
            )}
            {stage === "wallet" ? (
              <div className="waiting" aria-live="polite">
                <p>
                  <span className="spin" aria-hidden="true" /> <strong>Confirm in {walletName}.</strong>
                </p>
                {walletShows ? (
                  <>
                    <p className="small">{walletName} shows:</p>
                    <Shows text={walletShows} />
                    <p className="small">Same characters at the start and the end? Confirm. Different, or you did not ask for this? Cancel.</p>
                  </>
                ) : (
                  <p className="small">{walletWillShow(lock, walletName, state?.domain ?? location.host)}</p>
                )}
                <p className="small">Its window may be behind this one, or in another tab.</p>
              </div>
            ) : (
              <div className="will">
                <p className="small">
                  <strong>What {walletName} will show.</strong> {walletWillShow(lock, walletName, state?.domain ?? location.host)}
                </p>
              </div>
            )}
            <button className="primary" disabled={!!stage || voting || closing || !account || !!prepError} onClick={bind}>
              {stage && <span className="spin" aria-hidden="true" />} {bindLabel}
            </button>
            <p className="small">Not a payment: it can never be sent, and it costs nothing.</p>
            {voting && <p className="small">Sign-up reopens when voting ends, in {clock(phaseLeft)}.</p>}
            {closing && <p className="small">Voting starts in {clock(phaseLeft)}, too soon to finish signing up. Sign-up reopens after it.</p>}
            {changing && (
              <button className="link" onClick={() => (setChanging(false), (nameTouched.current = false), setAccount(mine.account ?? account))}>
                Keep the name {lockBound?.account}
              </button>
            )}
          </div>
        )}
        {bindNote && <p className={bindNote.ok ? "note ok" : "note bad"}>{bindNote.text}</p>}
        {mine.account && mine.bindings.filter((b) => !lock || b.lock_hash !== lock.hash()).length > 0 && (
          <div className="card">
            <p className="small">Also signed up as {mine.account} in this browser:</p>
            {mine.bindings
              .filter((b) => !lock || b.lock_hash !== lock.hash())
              .map((b) => (
                <p key={b.lock_hash} className="row small">
                  <span className="mono">{label(b.lock_hash)}</span>
                  <span>since {timeOf(b.bound_at)}</span>
                  <button className="link" disabled={voting} onClick={() => unbind(b.lock_hash)}>
                    remove
                  </button>
                </p>
              ))}
          </div>
        )}
      </section>

      <section className="step">
        <h2>
          <span className={`num ${myChoice ? "done" : ""}`}>{myChoice ? "✓" : "3"}</span> Vote
        </h2>
        <p className="question">{state?.question}</p>
        {voting ? (
          mine.account ? (
            <>
              <div className="choices">
                {state?.options.map((o) => (
                  <button key={o} className={myChoice === o ? "chosen" : ""} aria-pressed={myChoice === o} disabled={voteBusy} onClick={() => vote(o)}>
                    {myChoice === o ? `✓ ${o}` : o}
                  </button>
                ))}
              </div>
              {voteBusy && (
                <p className="small">
                  <span className="spin" aria-hidden="true" /> Counting your deposit…
                </p>
              )}
              {voteNote && <p className="note bad">{voteNote}</p>}
              {myVote && myVote.choice === myChoice ? (
                <div className="card">
                  <p>
                    <strong>
                      You voted {myVote.choice}. It counts as {ckb(myVote.weight)}.
                    </strong>
                  </p>
                  {myVote.locks.map((l) => (
                    <p key={l.lockHash} className="small">
                      {plainCount(l, label(l.lockHash), state?.cooldownMinutes ?? 20)}
                    </p>
                  ))}
                  <p className="small">You can change your vote until voting ends, in {clock(phaseLeft)}.</p>
                </div>
              ) : myChoice ? (
                <p className="small">You voted {myChoice}. You can change it until voting ends, in {clock(phaseLeft)}.</p>
              ) : (
                <p className="small">You can change your vote until voting ends.</p>
              )}
            </>
          ) : (
            <p className="small">To vote, sign up (steps 1 and 2) when this round ends, in {clock(phaseLeft)}.</p>
          )
        ) : (
          <p className="small">
            Voting starts in {clock(phaseLeft)}. {mine.account ? "Yes and No buttons appear here then." : "Sign up first (steps 1 and 2); Yes and No buttons appear here when voting opens."}
          </p>
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
      </>
      )}
    </>
  );
}
