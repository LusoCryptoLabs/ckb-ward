import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { LUSO, NPM, REPO, SPEC, VOTE_DEMO, WalletControl, WalletProvider, type Net } from "./lib";
import { Prove } from "./examples/Prove";
import { SignIn } from "./examples/SignIn";
import { ReadProof } from "./examples/ReadProof";
import { MessageTemplate } from "./examples/MessageTemplate";
import { TokenGate } from "./examples/TokenGate";

/** A hexagon "cell" framing a glyph, the motif of the whole page. */
function Cell({ children }: { children: ReactNode }) {
  return (
    <span className="ico" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {children}
      </svg>
    </span>
  );
}
const IconProve = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <path d="M8.5 12l2.5 2.5 4.5-5" />
  </Cell>
);
const IconSignIn = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <circle cx="10" cy="11" r="2.4" />
    <path d="M11.7 12.3L16 16.6M14.4 15l-1.3 1.3M15.6 16.2l-1.1 1.1" />
  </Cell>
);
const IconRead = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <path d="M6.5 12s2.2-3.5 5.5-3.5S17.5 12 17.5 12 15.3 15.5 12 15.5 6.5 12 6.5 12z" />
    <circle cx="12" cy="12" r="1.3" />
  </Cell>
);
const IconMessage = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <path d="M10 8.5c-1.5 0-2 .8-2 2 0 1-.4 1.5-1.2 1.5.8 0 1.2.5 1.2 1.5 0 1.2.5 2 2 2M14 8.5c1.5 0 2 .8 2 2 0 1 .4 1.5 1.2 1.5-.8 0-1.2.5-1.2 1.5 0 1.2-.5 2-2 2" />
  </Cell>
);

const IconGate = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <rect x="8.5" y="11" width="7" height="5.5" rx="1" />
    <path d="M9.9 11V9.6a2.1 2.1 0 0 1 4.2 0V11" />
  </Cell>
);
const IconVote = () => (
  <Cell>
    <path d="M12 2l8.5 5v10L12 22 3.5 17V7z" />
    <path d="M8 16v-3M12 16v-6M16 16v-2" />
  </Cell>
);

type Ex = { id: string; group: string; title: string; blurb: string; Icon: ComponentType; Comp?: ComponentType; href?: string };

const EXAMPLES: Ex[] = [
  { id: "prove", group: "how", title: "Prove a wallet is yours", blurb: "Show a wallet belongs to you with one signature. Nothing is sent.", Icon: IconProve, Comp: Prove },
  { id: "read", group: "how", title: "What a wallet shows", blurb: "See what your wallet shows you when a site asks you to prove it.", Icon: IconRead, Comp: ReadProof },
  { id: "message", group: "how", title: "What you sign", blurb: "See exactly what your wallet is asked to sign, in plain text.", Icon: IconMessage, Comp: MessageTemplate },
  { id: "signin", group: "build", title: "Sign in with a wallet", blurb: "Enter a site with your wallet, no password and no account.", Icon: IconSignIn, Comp: SignIn },
  { id: "gate", group: "build", title: "Members only", blurb: "Open a community, content, or a mint to wallets that hold enough.", Icon: IconGate, Comp: TokenGate },
  { id: "vote", group: "build", title: "DAO voting", blurb: "Count any wallet's Nervos DAO deposit in a community vote.", Icon: IconVote, href: VOTE_DEMO },
];

const GROUPS = [
  { key: "how", label: "How it works", blurb: "The building block, and what your wallet does with it." },
  { key: "build", label: "What you can build", blurb: "Real things sites can do once a wallet is proven." },
];

/** The Ward mark: the favicon's lettered cell. */
function Logo() {
  return (
    <a className="brand" href="#">
      <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden="true">
        <path d="M16 2l12 7v14l-12 7L4 23V9z" className="brand-cell" />
        <path d="M10 11l3 10 3-7 3 7 3-10" className="brand-w" fill="none" strokeWidth="2.4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <span>Ward</span>
    </a>
  );
}

function Footer() {
  return (
    <footer className="small">
      Ward is lock proof for CKB, by <a href={LUSO}>LusoCryptoLabs</a>. Open source: read the <a href={SPEC}>spec</a>, the <a href={REPO}>code</a>, or the package on <a href={NPM}>npm</a>. It is
      the CKB counterpart of Ethereum's EIP-1271 and Bitcoin's BIP-322. For a full platform built on it, see the <a href={VOTE_DEMO}>DAO voting demo</a>.
    </footer>
  );
}

export function App({ network, setNetwork }: { network: Net; setNetwork: (n: Net) => void }) {
  const [active, setActive] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const f = () => {
      setActive(location.hash.slice(1));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const current = EXAMPLES.find((e) => e.id === active && e.Comp);
  const Current = current?.Comp;

  return (
    <WalletProvider network={network}>
      <div className="bg" aria-hidden="true" />
      <main>
        <nav className="site">
          <span className="brandcol">
            <Logo />
            <a className="by" href={LUSO}>
              by LusoCryptoLabs
            </a>
          </span>
          <div className="site-right">
            <div className="netswitch" role="group" aria-label="Network">
              {(["testnet", "mainnet"] as const).map((n) => (
                <button
                  key={n}
                  type="button"
                  className={network === n ? "on" : ""}
                  aria-pressed={network === n}
                  title={n === "testnet" ? "Practice network, nothing here is real" : "The real network"}
                  onClick={() => setNetwork(n)}
                >
                  {n}
                </button>
              ))}
            </div>
            <WalletControl />
          </div>
        </nav>

        {current && Current ? (
          <section className="ex">
            <a className="back" href="#">
              ← All examples
            </a>
            <h1 className="ex-title">
              <span className="ex-ico">
                <current.Icon />
              </span>
              {current.title}
            </h1>
            <Current />
          </section>
        ) : (
          <>
            <header className="hero">
              <h1>
                Prove a wallet is <span className="grad">yours</span>
              </h1>
              <p className="lead">
                Show that a CKB wallet belongs to you, with a single signature. Nothing is sent and nothing is spent, on any network. It is how you link a wallet to an account, sign in, or
                prove what you hold, without moving anything. Try each piece below.
              </p>
            </header>
            {GROUPS.map((g) => (
              <section key={g.key} className="group">
                <h2 className="group-title">{g.label}</h2>
                <p className="small group-blurb">{g.blurb}</p>
                <div className="tiles">
                  {EXAMPLES.filter((e) => e.group === g.key).map((e) => (
                    <a key={e.id} className="tile" href={e.href ?? `#${e.id}`} {...(e.href ? { target: "_blank", rel: "noreferrer" } : {})}>
                      <span className="ico-badge">
                        <e.Icon />
                      </span>
                      <h2>{e.title}</h2>
                      <p>{e.blurb}</p>
                      <span className="tile-go">{e.href ? "Open demo ↗" : "Open →"}</span>
                    </a>
                  ))}
                </div>
              </section>
            ))}
          </>
        )}

        <Footer />
      </main>
    </WalletProvider>
  );
}
