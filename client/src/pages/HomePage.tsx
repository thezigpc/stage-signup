import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BackToGames } from "@bargames/gamekit/client";
import type { JoinResult, Mode } from "@signup/shared";
import { call } from "../socket";
import { deviceId, lastSignup, loadSession, saveSession } from "../session";
import { useGameName } from "../useGameName";
import { useVenue } from "../useVenue";

const CODE_LEN = 4;

export function HomePage() {
  const navigate = useNavigate();
  const params = useParams();
  const [search] = useSearchParams();
  const gameName = useGameName();
  const venue = useVenue();
  const [code, setCode] = useState((params.code ?? "").toUpperCase());
  const [cohostName, setCohostName] = useState(lastSignup().name ?? "");
  const [mode, setMode] = useState<Mode>("karaoke");
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const started = useRef(false);

  // /join/ABCD?cohost=<invite>: the host's (or the box's) "Add a co-host" QR. Single use.
  const cohostInvite = search.get("cohost") ?? undefined;

  const enter = (r: JoinResult) => {
    saveSession({ roomCode: r.code, token: r.token, name: r.name, role: r.role });
    navigate(`/room/${r.code}`, { replace: true });
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const join = (role: "patron" | "table", roomCode = code) =>
    run(async () => {
      const c = roomCode.trim().toUpperCase();
      if (c.length !== CODE_LEN) throw new Error("Room codes are 4 letters.");
      const existing = loadSession();
      const token = existing?.roomCode === c && (existing.role === role || role === "patron") ? existing.token : undefined;
      enter(
        await call<JoinResult>("joinRoom", {
          code: c,
          role,
          token,
          device: role === "patron" ? deviceId() : undefined,
          name: cohostInvite ? cohostName.trim() : undefined,
          cohost: role === "patron" ? cohostInvite : undefined,
        }),
      );
    });

  const host = () =>
    run(async () => {
      enter(await call<JoinResult>("createRoom", { mode, title: title.trim() || undefined }));
    });

  // Links that open a room straight away:
  // - /join/ABCD?host=<key>: the host link (the box's "Open the host controls", a take-over).
  // - /join/ABCD?as=table: the TV view (the box casts this; no gesture needed).
  // - /join/ABCD: a patron scanning the QR code goes straight to the signup form.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const c = (params.code ?? "").toUpperCase();
    if (c.length !== CODE_LEN) return;
    const hostKey = search.get("host");
    if (hostKey) {
      saveSession({ roomCode: c, token: hostKey, name: "Host", role: "host" });
      navigate(`/room/${c}`, { replace: true });
      return;
    }
    if (search.get("as") === "table") join("table", c);
    else if (!cohostInvite) join("patron", c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJoin = (e: FormEvent) => {
    e.preventDefault();
    join("patron");
  };

  const linkOpening = busy && (search.get("as") === "table" || (!!params.code && !cohostInvite));
  if (linkOpening) {
    return (
      <main className="center-page">
        <p className="muted">Opening the list…</p>
      </main>
    );
  }

  return (
    <main className="home">
      <header className="home-hero">
        <div className="hero-mic" aria-hidden>
          🎤
        </div>
        <h1>{gameName}</h1>
        <p className="muted">Put your name on the list for karaoke or open mic, right from your phone.</p>
      </header>

      <form className="panel" onSubmit={onJoin}>
        <h2>{cohostInvite ? "Join as a co-host" : "Sign up"}</h2>
        {cohostInvite && (
          <p className="muted small">
            You'll be able to run the list: reorder it, bring people up and pause signups. This link works once.
          </p>
        )}
        <label>
          Room code
          <input
            value={code}
            onChange={(e) =>
              setCode(
                e.target.value
                  .toUpperCase()
                  .replace(/[^A-Z]/g, "")
                  .slice(0, CODE_LEN),
              )
            }
            placeholder="ABCD"
            autoCapitalize="characters"
            autoComplete="off"
            className="code-input"
          />
        </label>
        {cohostInvite && (
          <label>
            Your name
            <input
              value={cohostName}
              onChange={(e) => setCohostName(e.target.value.slice(0, 30))}
              placeholder="Name"
              autoComplete="nickname"
            />
          </label>
        )}
        <button
          className="btn btn-primary btn-big"
          disabled={busy || code.length !== CODE_LEN || (!!cohostInvite && !cohostName.trim())}
        >
          {cohostInvite ? "Join as co-host" : "Open the list"}
        </button>
        {!cohostInvite && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={busy || code.length !== CODE_LEN}
            onClick={() => join("table")}
          >
            Show this list on a TV
          </button>
        )}
      </form>

      {!cohostInvite && (
        <section className="panel">
          <h2>Host a night</h2>
          <p className="muted">Start tonight's list. People sign up with the room code or the QR code on the TV.</p>
          <div className="seg" role="radiogroup" aria-label="Kind of night">
            <button
              type="button"
              role="radio"
              aria-checked={mode === "karaoke"}
              className={mode === "karaoke" ? "on" : ""}
              onClick={() => setMode("karaoke")}
            >
              🎤 Karaoke
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={mode === "openmic"}
              className={mode === "openmic" ? "on" : ""}
              onClick={() => setMode("openmic")}
            >
              🎸 Open mic
            </button>
          </div>
          <label>
            Name of the night (optional)
            <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 60))} placeholder="Friday Karaoke" />
          </label>
          <button className="btn btn-secondary btn-big" disabled={busy} onClick={host}>
            Start the list
          </button>
        </section>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="home-foot">
        <Link to="/admin" className="muted small">
          Admin
        </Link>
      </footer>

      {/* Bar Games: back to the venue's games list. Landing page only. Nothing off a box. */}
      {!search.get("as") && !search.get("host") && !cohostInvite && <BackToGames ctx={venue} />}
    </main>
  );
}
