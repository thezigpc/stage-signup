import { useState, type FormEvent } from "react";
import { LIMITS, type EntryInput, type StageView } from "@signup/shared";
import { EntryDetail, STATUS_LABEL, useNow, waitText } from "../components/bits";
import { lastSignup, rememberSignup } from "../session";
import { call } from "../socket";

type OnError = (message: string) => void;

/** A socket intent; a refusal shows as a toast. Resolves null when refused. */
async function send<T = object>(onError: OnError, event: "signUp" | "dropOut", arg: unknown): Promise<T | null> {
  try {
    return await call<T>(event, arg);
  } catch (err) {
    onError(err instanceof Error ? err.message : "Something went wrong.");
    return null;
  }
}

const UP_NEXT_SHOWN = 5;

/** A patron's phone: their place in line, the signup form, and who's on. */
export function PatronView({ view, skew, onError }: { view: StageView; skew: number; onError: OnError }) {
  const now = useNow(skew);
  const karaoke = view.stage.mode === "karaoke";
  const active = view.mine.find((e) => e.status === "waiting" || e.status === "up");
  const position = active?.status === "waiting" ? view.queue.findIndex((e) => e.id === active.id) + 1 : 0;
  const past = view.mine.filter((e) => e !== active);

  return (
    <main className="patron">
      <div className="stage-head">
        <h1>{view.stage.name}</h1>
        <span className="muted">
          {view.queue.length} waiting{view.live.signupsOpen ? "" : " · signups paused"}
        </span>
      </div>

      {view.live.message && (
        <p className="host-message" role="status">
          📣 {view.live.message}
        </p>
      )}

      <section className="panel now-panel">
        <h2 className="eyebrow">On stage now</h2>
        {view.now ? (
          <div className="now-line">
            <strong>{view.now.mine ? "You!" : view.now.name}</strong>
            <EntryDetail e={view.now} />
          </div>
        ) : (
          <p className="muted">Nobody yet.</p>
        )}
      </section>

      {active?.status === "up" && (
        <section className="panel mine-panel up" role="status">
          <h2>🎉 You're on now!</h2>
          <p>Head to the stage.</p>
        </section>
      )}

      {active?.status === "waiting" && (
        <section className="panel mine-panel">
          <h2 className="eyebrow">You're on the list</h2>
          <div className="place">
            <span className="place-num">#{position}</span>
            <span className="place-wait">{waitText(view, position, now)}</span>
          </div>
          <div className="now-line">
            <strong>{active.name}</strong>
            <EntryDetail e={active} showNote />
          </div>
          <button
            className="btn btn-ghost"
            onClick={() => window.confirm("Drop out? You lose your place in line.") && send(onError, "dropOut", active.id)}
          >
            Drop out
          </button>
        </section>
      )}

      {!active &&
        (view.gate.ok ? (
          <SignupForm karaoke={karaoke} onError={onError} />
        ) : (
          <section className="panel">
            <h2>Sign up</h2>
            <p className="muted">{view.gate.reason}</p>
          </section>
        ))}

      <section className="panel">
        <h2>
          Up next <span className="muted">({view.queue.length})</span>
        </h2>
        {view.queue.length === 0 ? (
          <p className="muted">Nobody's waiting. Be the first!</p>
        ) : (
          <ol className="upnext">
            {view.queue.slice(0, UP_NEXT_SHOWN).map((e) => (
              <li key={e.id} className={e.mine ? "mine" : ""}>
                <span className="grow">{e.mine ? `${e.name} (you)` : e.name}</span>
              </li>
            ))}
          </ol>
        )}
        {view.queue.length > UP_NEXT_SHOWN && (
          <p className="muted small">and {view.queue.length - UP_NEXT_SHOWN} more</p>
        )}
      </section>

      {past.length > 0 && (
        <section className="panel">
          <h2>Your signups tonight</h2>
          <ul className="history">
            {past.map((e) => (
              <li key={e.id}>
                <span className="grow">
                  {e.name} <EntryDetail e={e} />
                </span>
                <span className="muted small">{STATUS_LABEL[e.status]}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

function SignupForm({ karaoke, onError }: { karaoke: boolean; onError: OnError }) {
  const last = lastSignup();
  const [name, setName] = useState(last.name ?? "");
  const [song, setSong] = useState("");
  const [artist, setArtist] = useState("");
  const [note, setNote] = useState("");
  const [friend, setFriend] = useState("");
  const [withFriend, setWithFriend] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const entry: EntryInput = karaoke
      ? { name: name.trim(), song: song.trim(), artist: artist.trim() }
      : { name: name.trim(), note: note.trim() };
    if (withFriend && friend.trim()) entry.with = friend.trim();
    setBusy(true);
    const ok = await send(onError, "signUp", entry);
    setBusy(false);
    if (ok) rememberSignup({ name: entry.name });
  };

  return (
    <form className="panel signup" onSubmit={submit}>
      <h2>Sign up</h2>
      <label>
        Name or stage name
        <input
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, LIMITS.name))}
          placeholder="Name"
          autoComplete="nickname"
          required
        />
      </label>
      {karaoke ? (
        <>
          <label>
            Song
            <input
              value={song}
              onChange={(e) => setSong(e.target.value.slice(0, LIMITS.song))}
              placeholder="Song title"
              required
            />
          </label>
          <label>
            Artist
            <input
              value={artist}
              onChange={(e) => setArtist(e.target.value.slice(0, LIMITS.artist))}
              placeholder="Who sings it"
            />
          </label>
        </>
      ) : (
        <label>
          Note for the host (optional)
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, LIMITS.note))}
            placeholder="What you'll do, what you need (a stool, a second mic…)"
            rows={3}
          />
        </label>
      )}
      <label className="check">
        <input type="checkbox" checked={withFriend} onChange={(e) => setWithFriend(e.target.checked)} />
        {karaoke ? "With a friend (a duet or group)" : "With a friend (a duo or band)"}
      </label>
      {withFriend && (
        <label>
          Who's with you
          <input
            value={friend}
            onChange={(e) => setFriend(e.target.value.slice(0, LIMITS.with))}
            placeholder="Their names"
          />
        </label>
      )}
      <button className="btn btn-primary btn-big" disabled={busy || !name.trim() || (karaoke && !song.trim())}>
        Put me on the list
      </button>
    </form>
  );
}
