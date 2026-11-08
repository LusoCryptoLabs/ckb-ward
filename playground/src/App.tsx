import { useEffect, useState } from "react";
import { NPM, REPO, SPEC, VOTE_DEMO, WalletProvider } from "./lib";
import { Prove } from "./examples/Prove";
import { SignIn } from "./examples/SignIn";
import { ReadProof } from "./examples/ReadProof";
import { MessageTemplate } from "./examples/MessageTemplate";

const EXAMPLES = [
  { id: "prove", title: "Prove a lock", Comp: Prove },
  { id: "signin", title: "Sign in", Comp: SignIn },
  { id: "read", title: "Read a proof", Comp: ReadProof },
  { id: "message", title: "Message & template", Comp: MessageTemplate },
];

export function App() {
  const [active, setActive] = useState(() => location.hash.slice(1) || "prove");
  useEffect(() => {
    const f = () => setActive(location.hash.slice(1) || "prove");
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  const current = EXAMPLES.find((e) => e.id === active) ?? EXAMPLES[0];
  const Current = current.Comp;

  return (
    <WalletProvider>
      <main>
        <header>
          <p className="tag">Testnet · no real money</p>
          <h1>Ward playground</h1>
          <p className="lead">
            Lock proof for CKB: prove any wallet controls its lock, by running the lock on a transaction that can never land. The CKB counterpart of Ethereum's EIP-1271 and Bitcoin's
            BIP-322. Try each piece below.
          </p>
        </header>

        <nav className="tabs">
          {EXAMPLES.map((e) => (
            <a key={e.id} href={`#${e.id}`} className={e.id === current.id ? "on" : ""} aria-current={e.id === current.id ? "page" : undefined}>
              {e.title}
            </a>
          ))}
        </nav>

        <Current />

        <footer>
          <p className="small">
            Ward is open source. Read the <a href={SPEC}>spec</a>, the <a href={REPO}>code</a>, or the package on <a href={NPM}>npm</a>. For a full platform built on it, see the{" "}
            <a href={VOTE_DEMO}>DAO voting demo</a>, where Nervos DAO deposits from any wallet count in a test vote.
          </p>
        </footer>
      </main>
    </WalletProvider>
  );
}
