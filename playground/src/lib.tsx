import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ccc } from "@ckb-ccc/connector-react";

export const REPO = "https://github.com/LusoCryptoLabs/ckb-ward";
export const SPEC = `${REPO}/blob/main/docs/SPEC.md`;
export const NPM = "https://www.npmjs.com/package/ckb-ward";
export const VOTE_DEMO = "https://ward-demo.lusocryptolabs.com";
/** A proof request is good for 10 minutes on the server; fetch a new one before that. */
const PREPARED_FOR_MS = 8 * 60_000;

export async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? { credentials: "same-origin" } : { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { reason?: string }).reason ?? `HTTP ${res.status}`);
  return json as T;
}

export const plainScript = (s: ccc.Script) => ({ codeHash: s.codeHash, hashType: s.hashType, args: s.args });
export const shortAddress = (a: string) => (a.length > 24 ? `${a.slice(0, 8)}…${a.slice(-12)}` : a);
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`;
export const timeOf = (iso: string | number) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
export const ckb = (shannons: string | bigint) => {
  const n = BigInt(shannons);
  const whole = n / 100_000_000n;
  const cents = (n % 100_000_000n) / 1_000_000n;
  return `${whole.toLocaleString("en")}${cents ? `.${cents.toString().padStart(2, "0")}` : ""} CKB`;
};

// Lock code hashes, by network, from CCC's known scripts. secp256k1 and multisig match across
// networks; the rest differ.
const OMNILOCK = ["0xf329effd1c475a2978453c8600e1eaf0bc2087ee093c3ee64cc96ec6847752cb", "0x9b819793a64463aed77c615d6cb226eea5487ccfc0783043a587254cda2b6f26"];
const PW_LOCK = ["0x58c5f491aba6d61678b7cf7edf4910b1f5e00ec0cde2f42e0abb4fd9aff25a63", "0xbf43c3602455798c1a61a596e0d95278864c552fafe231c063b3fabf97a8febc"];
const JOYID = ["0xd23761b364210735c19c60561d213fb3beae2fd6172743719eff6920e020baac", "0xd00c84f0ec8fd441c38bc3f87a371f547190f2fcff88e642bc5bf54b9e318323"];
const ACP = ["0x3419a1c09eb2567f6552ee7a8ecffd64155cffe0f1796e6e61ec088d740c1356", "0xd369597ff47f29fbc0d47d2e3775370d1250b85140c670e4718af712983a2354"];
const SECP = "0x9bd7e06f3ecf4be0f2fcd2188b23f1b9fcc88e5d4b65a8637b17723bbda3cce8";
const MULTISIG = "0x5c5069eb0857efc65e1bca0c07df34c31663b3622fd3876c876320fc9634e2a8";
const CELLULA = "0x8f73d5d875b70c248c281052c9f67e2d7a2dbbee47a1ae71e68f44fed47b436e";

/** A plain name for the lock a wallet uses, from its code hash, on either network. */
export function lockKind(lock: ccc.Script): string {
  if (OMNILOCK.includes(lock.codeHash)) {
    const mode = { "00": "CKB key", "01": "older Ethereum", "12": "Ethereum", "04": "Bitcoin", "05": "Dogecoin", "06": "multisig" }[lock.args.slice(2, 4)];
    return `Omnilock${mode ? `, ${mode} mode` : ""}`;
  }
  if (JOYID.includes(lock.codeHash)) return "JoyID";
  if (ACP.includes(lock.codeHash)) return "anyone-can-pay";
  if (PW_LOCK.includes(lock.codeHash)) return "Portal Wallet";
  const known: Record<string, string> = { [SECP]: "secp256k1", [MULTISIG]: "multisig", [CELLULA]: "Cellula smart account" };
  return known[lock.codeHash] ?? `lock ${shortHash(lock.codeHash)}`;
}

/** What the wallet shows when it signs, which the lock and CCC decide. */
export function walletWillShow(lock: ccc.Script, wallet: string, domain: string): string {
  const flag = OMNILOCK.includes(lock.codeHash) ? lock.args.slice(2, 4) : "";
  const shaped = "It says transaction because the proof is shaped like one, but it spends coins that do not exist, so it can never go through.";
  if (lock.codeHash === CELLULA) return `Cellula opens a page that says “${domain} asks you to prove this wallet is yours”, with this address.`;
  if (PW_LOCK.includes(lock.codeHash) || flag === "01")
    return `${wallet} opens a “Signature request” that shows only a code: 0x and 64 letters and digits. It may name Ethereum as the network. This page shows the same code while ${wallet} is open, so you can check they match.`;
  if (flag === "12") return `${wallet} shows “CKB transaction: 0x…” and may name Ethereum as the network. ${shaped} This page shows the same text while ${wallet} is open.`;
  if (flag === "04") return `${wallet} shows “CKB (Bitcoin Layer) transaction: 0x…”. ${shaped} This page shows the same text while ${wallet} is open.`;
  if (JOYID.includes(lock.codeHash)) return "JoyID opens and asks you to sign with your passkey.";
  return `${wallet} asks you to sign. It may call it a transaction or show a code.`;
}

export function plainError(reason: string): string {
  const table: [RegExp, string][] = [
    [/nonce already used|already used/i, "That signature was already used. Run it again for a fresh one."],
    [/not the proof template|unknown nonce|issued|expired|too old/i, "The signature did not match the request. Run it again."],
    [/lock exited|opens without|lock also opens/i, "The wallet's signature did not check out."],
    [/not live/i, "Part of the wallet changed on the network. Reconnect and run it again."],
    [/too many requests/i, "Too many tries. Wait a minute and try again."],
    [/node did not answer|could not answer/i, "The test network did not answer in time. Try again."],
    [/reject|refus|cancel|denied|closed/i, "You cancelled in your wallet. Nothing was signed."],
  ];
  return table.find(([re]) => re.test(reason))?.[1] ?? reason;
}

/** The text a wallet is asked to sign, with its first and last characters set apart to compare. */
export function Shows({ text }: { text: string }) {
  const code = /^0x[0-9a-f]{64}$/i.test(text) ? { head: text.slice(0, 8), mid: text.slice(8, -6), tail: text.slice(-6) } : null;
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

// --- wallet context: connect, pick an address, and run a proof --------------------------------

export type Net = "testnet" | "mainnet";
export type Stage = "" | "preparing" | "wallet" | "checking";
type Choice = { script: ccc.Script; address: string };
type Prepared = { key: string; nonce: string; template: unknown; at: number };
type Ctx = {
  signer: ccc.Signer | undefined;
  walletName: string;
  domain: string;
  open: () => void;
  disconnect: () => void;
  choices: Choice[];
  lock: ccc.Script | null;
  address: string;
  choose: (c: Choice) => void;
  stage: Stage;
  walletShows: string | null;
  /** Fetch a proof request, sign it, and post it to `endpoint`. Returns the server's JSON, throws its reason. */
  prove: <T>(endpoint: string) => Promise<T>;
};

const WalletContext = createContext<Ctx | null>(null);
export const useWallet = () => {
  const c = useContext(WalletContext);
  if (!c) throw new Error("useWallet outside provider");
  return c;
};

export function WalletProvider({ network, children }: { network: Net; children: ReactNode }) {
  const { open, disconnect, wallet } = ccc.useCcc();
  const signer = ccc.useSigner();
  const [choices, setChoices] = useState<Choice[]>([]);
  const [lock, setLock] = useState<ccc.Script | null>(null);
  const [address, setAddress] = useState("");
  const [stage, setStage] = useState<Stage>("");
  const [walletShows, setWalletShows] = useState<string | null>(null);
  const [domain, setDomain] = useState(location.host);
  const prepared = useRef<Prepared | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api<{ domain: string }>("/api/config").then((c) => setDomain(c.domain)).catch(() => {});
  }, []);

  const choose = useCallback((c: Choice) => {
    setLock(c.script);
    setAddress(c.address);
  }, []);

  // A wallet can hold more than one address; list them, and start with the one CCC recommends.
  useEffect(() => {
    setChoices([]);
    setLock(null);
    setAddress("");
    prepared.current = null;
    if (!signer) return;
    let gone = false;
    (async () => {
      const first = await signer.getRecommendedAddressObj();
      const all = await signer.getAddressObjs().catch(() => [first]);
      const seen = new Set<string>();
      const picked = [first, ...all].filter((o) => !PW_LOCK.includes(o.script.codeHash));
      const list = (picked.length ? picked : [first])
        .filter((o) => !seen.has(o.script.hash()) && !!seen.add(o.script.hash()))
        .slice(0, 4)
        .map((o) => ({ script: o.script, address: o.toString() }));
      if (gone) return;
      setChoices(list);
      choose(list[0]);
    })();
    return () => {
      gone = true;
    };
  }, [signer, choose]);

  const prepKey = lock && address ? `${lock.hash()}|${address}` : "";
  const minute = Math.floor(Date.now() / 60_000) + tick;
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Fetch the proof request ahead, so a tap opens the wallet at once (a phone browser can block a
  // wallet window opened a round trip after the tap).
  useEffect(() => {
    if (!signer || !lock || !address || stage) return;
    if (prepared.current?.key === prepKey && Date.now() - prepared.current.at < PREPARED_FOR_MS) return;
    let gone = false;
    const t = setTimeout(async () => {
      try {
        const n = await api<{ nonce: string; template: unknown }>("/api/nonce", { account: address, lock: plainScript(lock), network });
        if (!gone) prepared.current = { key: prepKey, nonce: n.nonce, template: n.template, at: Date.now() };
      } catch {
        /* the run will fetch a fresh one */
      }
    }, 400);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [signer, lock, address, prepKey, stage, minute, network]);

  const prove = useCallback(
    async <T,>(endpoint: string): Promise<T> => {
      if (!signer || !lock) throw new Error("connect a wallet first");
      setWalletShows(null);
      // CCC's EVM and Bitcoin signers pass the exact text through signMessageRaw, so the page can
      // show it beside the wallet's own screen.
      const s = signer as unknown as { signMessageRaw?: (m: string | ccc.BytesLike) => Promise<string> };
      const own = Object.prototype.hasOwnProperty.call(s, "signMessageRaw");
      const original = s.signMessageRaw;
      if (typeof original === "function")
        s.signMessageRaw = (m) => {
          setWalletShows(typeof m === "string" ? m : ccc.hexFrom(m));
          return original.call(signer, m);
        };
      try {
        let n = prepared.current?.key === prepKey && Date.now() - prepared.current.at < PREPARED_FOR_MS ? prepared.current : null;
        if (!n) {
          setStage("preparing");
          const fresh = await api<{ nonce: string; template: unknown }>("/api/nonce", { account: address, lock: plainScript(lock), network });
          n = { key: prepKey, nonce: fresh.nonce, template: fresh.template, at: Date.now() };
        }
        setStage("wallet");
        const signed = await signer.signTransaction(ccc.Transaction.from(n.template as ccc.TransactionLike));
        setStage("checking");
        prepared.current = null;
        return await api<T>(endpoint, { nonce: n.nonce, tx: JSON.parse(signed.stringify()) });
      } finally {
        if (own) s.signMessageRaw = original;
        else delete s.signMessageRaw;
        setStage("");
        setWalletShows(null);
      }
    },
    [signer, lock, address, prepKey, network],
  );

  const value: Ctx = {
    signer,
    walletName: wallet?.name ?? "Your wallet",
    domain,
    open,
    disconnect,
    choices,
    lock,
    address,
    choose,
    stage,
    walletShows,
    prove,
  };
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

/** The central connect/disconnect control, in the header. The connection is global, so one place
 * drives it for every example. */
export function WalletControl() {
  const { signer, lock, walletName, address, open, disconnect, stage } = useWallet();
  if (!signer || !lock)
    return (
      <button className="wc-connect" disabled={!!stage} onClick={open}>
        Connect a wallet
      </button>
    );
  return (
    <span className="wc">
      <span className="wc-id" title={address}>
        {walletName}
      </span>
      <button className="link wc-x" disabled={!!stage} onClick={disconnect}>
        Disconnect
      </button>
    </span>
  );
}

/** In an example: the connected wallet's address and address picker, or a nudge to connect above. */
export function Connect() {
  const { signer, walletName, choices, lock, address, choose, stage } = useWallet();
  const [copied, setCopied] = useState(false);
  if (!signer || !lock) return <p className="small">Connect a wallet at the top of the page to try this. Cellula, JoyID, MetaMask, UniSat, OKX, UTXO Global and more. No test CKB needed.</p>;
  return (
    <div className="card connect">
      <p className="row">
        <strong>{walletName}</strong>
        <span className="small">{lockKind(lock)}</span>
      </p>
      <p className="row">
        <span className="mono">{shortAddress(address)}</span>
        <button className="copy" onClick={() => navigator.clipboard?.writeText(address).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)), () => {})}>
          {copied ? "Copied" : "Copy"}
        </button>
      </p>
      {choices.length > 1 && (
        <fieldset className="pick">
          <legend className="small">This wallet has {choices.length} addresses. Pick one to use in the examples.</legend>
          {choices.map((c) => (
            <label key={c.script.hash()}>
              <input type="radio" name="address" checked={lock.hash() === c.script.hash()} disabled={!!stage} onChange={() => choose(c)} />
              <span>
                {lockKind(c.script)} · <span className="mono">{shortAddress(c.address)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

/** The sign button with its waiting panel, shared by the examples that produce a proof. */
export function SignButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { stage, walletShows, walletName, lock, domain } = useWallet();
  const text = { "": label, preparing: "Preparing…", wallet: `Waiting for ${walletName}…`, checking: "Checking the signature…" }[stage];
  return (
    <>
      {stage === "wallet" && (
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
            lock && <p className="small">{walletWillShow(lock, walletName, domain)}</p>
          )}
          <p className="small">Its window may be behind this one, or in another tab.</p>
        </div>
      )}
      <button className="primary" disabled={!!stage} onClick={onClick}>
        {stage && <span className="spin" aria-hidden="true" />} {text}
      </button>
    </>
  );
}
