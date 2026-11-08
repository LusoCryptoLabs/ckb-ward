import { useEffect, useState, type ReactNode } from "react";
import { NPM, REPO, SPEC, VOTE_DEMO, WalletControl, WalletProvider, type Net } from "./lib";
import { Prove } from "./examples/Prove";
import { SignIn } from "./examples/SignIn";
import { ReadProof } from "./examples/ReadProof";
import { MessageTemplate } from "./examples/MessageTemplate";

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

const EXAMPLES = [
  { id: "prove", title: "Prove a lock", blurb: "Any wallet proves it controls its lock, checked in CKB-VM.", Icon: IconProve, Comp: Prove },
  { id: "signin", title: "Sign in", blurb: "A session from one signature. EIP-1271 and BIP-322, for CKB.", Icon: IconSignIn, Comp: SignIn },
  { id: "read", title: "Read a proof", blurb: "See what a wallet sees in a proof request, in the browser.", Icon: IconRead, Comp: ReadProof },
  { id: "message", title: "Message & template", blurb: "The proof built byte by byte, as you type.", Icon: IconMessage, Comp: MessageTemplate },
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
      Ward is open source. Read the <a href={SPEC}>spec</a>, the <a href={REPO}>code</a>, or the package on <a href={NPM}>npm</a>. For a full platform built on it, see the{" "}
      <a href={VOTE_DEMO}>DAO voting demo</a>.
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
  const current = EXAMPLES.find((e) => e.id === active);

  return (
    <WalletProvider network={network}>
      <div className="bg" aria-hidden="true" />
      <main>
        <nav className="site">
          <Logo />
          <div className="site-right">
            <div className="netswitch" role="group" aria-label="Network">
              {(["testnet", "mainnet"] as const).map((n) => (
                <button key={n} type="button" className={network === n ? "on" : ""} aria-pressed={network === n} onClick={() => setNetwork(n)}>
                  {n}
                </button>
              ))}
            </div>
            <WalletControl />
          </div>
        </nav>

        {current ? (
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
            <current.Comp />
          </section>
        ) : (
          <>
            <header className="hero">
              <h1>
                Lock proof for <span className="grad">CKB</span>
              </h1>
              <p className="lead">
                Prove any wallet controls its lock, by running the lock on a transaction that can never land. The CKB counterpart of Ethereum's EIP-1271 and Bitcoin's BIP-322. Try each
                piece.
              </p>
            </header>
            <div className="tiles">
              {EXAMPLES.map((e) => (
                <a key={e.id} className="tile" href={`#${e.id}`}>
                  <span className="ico-badge">
                    <e.Icon />
                  </span>
                  <h2>{e.title}</h2>
                  <p>{e.blurb}</p>
                  <span className="tile-go">Open →</span>
                </a>
              ))}
            </div>
          </>
        )}

        <Footer />
      </main>
    </WalletProvider>
  );
}
