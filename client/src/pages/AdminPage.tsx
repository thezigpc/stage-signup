import { useCallback, useEffect, useState, type FormEvent } from "react";
import { StagesAdmin } from "./StagesAdmin";
import { Link } from "react-router-dom";
import { BoxAdminLink, staffSignIn } from "@bargames/gamekit/client";
import { useVenue } from "../useVenue";
import { serverUrl } from "../socket";
import { loadAdminToken as loadToken, saveAdminToken as saveToken } from "../session";

async function api<T>(path: string, token: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`${serverUrl}/api/admin${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? `Request failed (${res.status}).`), { status: res.status });
  return body as T;
}

/** The kit's /api/admin/status (venueLogin and setupAllowed only on a box). */
interface AdminStatus {
  setupNeeded: boolean;
  authenticated: boolean;
  trusted?: boolean;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

export function AdminPage() {
  const [token, setToken] = useState(loadToken);
  const [status, setStatus] = useState<AdminStatus | null>(null);
  const [error, setError] = useState("");
  const [signedOut, setSignedOut] = useState(false);
  const venue = useVenue();

  const refreshStatus = useCallback(() => {
    api<AdminStatus>("/status", token)
      .then(async (s) => {
        // Venue staff (the box vouches for this browser): a session without the password.
        // Never true off a box.
        if (!s.authenticated && s.trusted && !signedOut) {
          const t = await staffSignIn(serverUrl);
          if (t) {
            saveToken(t);
            setToken(t);
            return;
          }
        }
        setStatus(s);
      })
      .catch((e: Error) => setError(e.message));
  }, [token, signedOut]);
  useEffect(refreshStatus, [refreshStatus]);

  const signedIn = (t: string) => {
    saveToken(t);
    setToken(t);
  };
  const signOut = async () => {
    await api("/logout", token, { method: "POST" }).catch(() => {});
    setSignedOut(true);
    signedIn("");
  };

  return (
    <main className="admin">
      <BoxAdminLink ctx={venue} />
      <header className="admin-head">
        <h1>Admin</h1>
        <Link to="/" className="muted">
          ← Home
        </Link>
      </header>
      {error && <p className="error">{error}</p>}
      {!status ? (
        <p className="muted">Loading…</p>
      ) : status.authenticated ? (
        <StagesAdmin token={token} api={api} onSignOut={signOut} onExpired={() => signedIn("")} />
      ) : (
        <PasswordForm status={status} onToken={signedIn} />
      )}
    </main>
  );
}

function PasswordForm({ status, onToken }: { status: AdminStatus; onToken: (t: string) => void }) {
  const setupNeeded = status.setupNeeded;
  // On a box the venue's admin password signs in here too, even before this app has one.
  const onBox = status.venueLogin === true;
  const canSetOwn = onBox && setupNeeded && status.setupAllowed === true;
  const [ownPassword, setOwnPassword] = useState(false);
  const setup = setupNeeded && (!onBox || (canSetOwn && ownPassword));
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup && password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api<{ token: string }>(setup ? "/setup" : "/login", "", { method: "POST", body: { password } });
      onToken(r.token);
    } catch (err) {
      const msg = (err as Error).message;
      setError(onBox && setupNeeded && !setup && /set up/i.test(msg) ? "That isn't the venue's admin password." : msg);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="panel admin-login" onSubmit={submit}>
      <h2>{setup ? "Set the admin password" : "Sign in"}</h2>
      {onBox && !setup && (
        <p className="muted small">
          {setupNeeded ? "Use the venue's admin password." : "Use this app's admin password, or the venue's admin password."}
        </p>
      )}
      {setup && (
        <p className="warning">
          No admin password has been set yet. Whoever sets it first becomes the admin, so do this now. The{" "}
          <code>ADMIN_PASSWORD</code> environment variable overrides it.
        </p>
      )}
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={setup ? "new-password" : "current-password"}
          autoFocus
        />
      </label>
      {setup && (
        <label>
          Confirm password
          <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn btn-primary btn-big" disabled={busy || password.length === 0}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {canSetOwn && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            setOwnPassword(!ownPassword);
            setError("");
          }}
        >
          {ownPassword ? "Sign in with the venue's password instead" : "Set a separate password for this app instead"}
        </button>
      )}
    </form>
  );
}

