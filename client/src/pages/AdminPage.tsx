import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { ADMIN_SETTINGS_LIMITS, type AdminOverview, type AdminRoomSummary } from "@signup/shared";
import { BoxAdminLink, staffSignIn } from "@bargames/gamekit/client";
import { useVenue } from "../useVenue";
import { serverUrl } from "../socket";

const TOKEN_KEY = "signup_admin_token";
const loadToken = () => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
const saveToken = (t: string) => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
};

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

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} h ${m % 60} min ago` : `${Math.floor(h / 24)} d ${h % 24} h ago`;
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
        <Dashboard token={token} onSignOut={signOut} onExpired={() => signedIn("")} />
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

function Dashboard({ token, onSignOut, onExpired }: { token: string; onSignOut: () => void; onExpired: () => void }) {
  const [data, setData] = useState<AdminOverview | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [idle, setIdle] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await api<AdminOverview>("/overview", token));
      setError("");
    } catch (err) {
      if ((err as { status?: number }).status === 401) onExpired();
      else setError((err as Error).message);
    }
  }, [token, onExpired]);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);
  useEffect(() => {
    if (data && idle === "") setIdle(String(data.settings.roomIdleMinutes));
  }, [data, idle]);

  const run = async (fn: () => Promise<string | void>) => {
    setError("");
    setNote("");
    try {
      const msg = await fn();
      if (msg) setNote(msg);
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const close = (r: AdminRoomSummary) =>
    window.confirm(`Close ${r.code}? Its list is lost and everyone is sent back to the home page.`) &&
    run(async () => {
      await api(`/rooms/${r.code}/close`, token, { method: "POST" });
      return `Closed ${r.code}.`;
    });

  const saveIdle = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api("/settings", token, { method: "PUT", body: { roomIdleMinutes: Number(idle) } });
      return "Saved.";
    });
  };

  const { min, max } = ADMIN_SETTINGS_LIMITS.roomIdleMinutes;
  const skew = data ? data.serverTime - Date.now() : 0;

  return (
    <>
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      <section className="panel">
        <div className="row spread">
          <h2>
            Lists <span className="muted">({data?.rooms.length ?? "…"})</span>
          </h2>
          <button className="btn btn-small btn-ghost" onClick={load}>
            Refresh
          </button>
        </div>
        {data && data.rooms.length === 0 && <p className="muted">No open lists.</p>}
        {data && data.rooms.length > 0 && (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>List</th>
                  <th>People</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.rooms.map((r) => (
                  <tr key={r.code}>
                    <td className="admin-code">{r.code}</td>
                    <td>
                      {r.title ?? (r.mode === "karaoke" ? "Karaoke" : "Open mic")}
                      <div className="muted small">
                        {r.now ? `Now: ${r.now}` : "Stage empty"} · {r.waiting} waiting · {r.turns} done
                        {!r.signupsOpen && " · paused"}
                      </div>
                    </td>
                    <td>
                      <span className={`dot ${r.hostConnected ? "on" : ""}`} /> host
                      <div className="muted small">
                        {r.patrons} phones{r.tables > 0 && ` · ${r.tables} TV${r.tables === 1 ? "" : "s"}`}
                      </div>
                    </td>
                    <td>{ago(Date.now() + skew - r.lastActivityAt)}</td>
                    <td>
                      <button className="btn btn-small btn-danger" onClick={() => close(r)}>
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Auto-close idle lists</h2>
        <form className="admin-form" onSubmit={saveIdle}>
          <label>
            Close a list automatically after this many minutes with nothing happening
            <input type="number" min={min} max={max} value={idle} onChange={(e) => setIdle(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={!data || Number(idle) === data.settings.roomIdleMinutes}>
            Save
          </button>
        </form>
        <p className="muted small">
          Between {min} minutes and {max / 1440} days. A list on a venue TV stays open while the TV shows it.
        </p>
      </section>

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </>
  );
}
