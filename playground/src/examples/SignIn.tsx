import { useCallback, useEffect, useState } from "react";
import { Connect, SignButton, api, plainError, shortAddress, useWallet } from "../lib";

type Me = { account: string | null; lockHash: string | null };

export function SignIn() {
  const { signer, lock, prove } = useWallet();
  const [me, setMe] = useState<Me>({ account: null, lockHash: null });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => api<Me>("/api/me").then(setMe).catch(() => {}), []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = async () => {
    setNote("");
    try {
      await prove("/api/signin");
      await refresh();
    } catch (e) {
      setNote(plainError((e as Error).message));
    }
  };
  const signOut = async () => {
    setBusy(true);
    try {
      await api("/api/signout", {});
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <p className="lead">
        Sign in to a site with any CKB wallet, with one signature and no account to create. This is what EIP-1271 does on Ethereum and BIP-322 on Bitcoin, for every CKB lock. The server
        issues a session only after Ward checks the proof.
      </p>
      {me.account ? (
        <>
          <div className="card">
            <p className="ok">
              <strong>✓ Signed in</strong>
            </p>
            <p className="row">
              <span className="small">as</span>
              <span className="mono">{shortAddress(me.account)}</span>
            </p>
            <p className="small">A session cookie was set after the proof checked out. This panel is behind that session: without it the server shows nothing here.</p>
            <button className="link" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>
          <div className="card">
            <p>
              <strong>Members only</strong>
            </p>
            <p className="small">You can see this because you proved you control the address above. A real site would show a profile, a dashboard, or gated content here.</p>
          </div>
        </>
      ) : (
        <>
          <Connect />
          {signer && lock && (
            <div className="card">
              <SignButton label="Sign in with this wallet" onClick={signIn} />
              <p className="small">One signature. Not a payment, and nothing is sent.</p>
            </div>
          )}
          {note && <p className="note bad">{note}</p>}
        </>
      )}
    </section>
  );
}
