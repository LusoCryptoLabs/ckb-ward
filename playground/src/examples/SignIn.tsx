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
        Sign in to a website with your wallet, the way you would "sign in with Google", but it is your CKB wallet. No password and no account to create: one signature and you are in. Nothing
        is sent.
      </p>
      <p className="small dev-note">For developers: the CKB counterpart of EIP-1271 and BIP-322. The server starts a session only after Ward checks the proof.</p>
      {me.account ? (
        <>
          <div className="card">
            <p className="ok">
              <strong>✓ You are in</strong>
            </p>
            <p className="row">
              <span className="small">as</span>
              <span className="mono">{shortAddress(me.account)}</span>
            </p>
            <p className="small">We gave this browser a session after checking your signature. The panel below is only shown once you are signed in.</p>
            <button className="link" disabled={busy} onClick={signOut}>
              Sign out
            </button>
          </div>
          <div className="card">
            <p>
              <strong>Members only</strong>
            </p>
            <p className="small">You can see this because you proved you control the wallet above. A real site would show your profile, a dashboard, or members' content here.</p>
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
