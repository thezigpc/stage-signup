import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { joinDisplay, joinUrl as venueJoinUrl } from "@bargames/sdk/client";
import { LIMITS, type EntryInput, type EntryView, type RoomSettings, type RoomView } from "@signup/shared";
import { EntryDetail, STATUS_LABEL, useNow, waitText } from "../components/bits";
import { QrCode } from "../components/QrCode";
import { useVenue } from "../useVenue";
import type { Act } from "./RoomPage";

/** The host's (and co-hosts') screen: the stage, the line, and the night's settings. */
export function HostView({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const isHost = view.you.role === "host";
  return (
    <main className="host">
      <NowPanel view={view} skew={skew} act={act} />
      <QueuePanel view={view} skew={skew} act={act} />
      <ControlsPanel view={view} act={act} />
      <AddPanel view={view} act={act} />
      <InvitePanel view={view} />
      <HistoryPanel view={view} act={act} />
      <SettingsPanel view={view} act={act} />
      {isHost && <CohostsPanel view={view} act={act} />}
    </main>
  );
}

function minutesSince(at: number | undefined, now: number): string {
  if (!at) return "";
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  return m < 1 ? "just now" : `${m} min`;
}

function NowPanel({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const now = useNow(skew, 30_000);
  const cur = view.now;
  const next = view.queue[0];
  return (
    <section className="panel now-panel host-now">
      <h2 className="eyebrow">On stage now</h2>
      {cur ? (
        <>
          <div className="now-line big">
            <strong>{cur.name}</strong>
            <EntryDetail e={cur} showNote />
            <span className="muted small">
              #{cur.turn} · on for {minutesSince(cur.startedAt, now)}
            </span>
          </div>
          <div className="row">
            <button className="btn btn-primary btn-big grow" onClick={() => act("nextPerformer")}>
              {next ? `Next: ${next.name} ▶` : "Done, nobody waiting"}
            </button>
          </div>
          <div className="row">
            <button className="btn btn-secondary" onClick={() => act("finishCurrent")} title="Done; the stage stays empty">
              ✓ Done
            </button>
            <button className="btn btn-ghost" onClick={() => act("skipEntry", cur.id)} title="A no-show: out of the line">
              Skip
            </button>
            <button className="btn btn-ghost" onClick={() => act("moveToEnd", cur.id)} title="Back in line, at the end">
              Move to end
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Nobody's on stage.</p>
          <button className="btn btn-primary btn-big" disabled={!next} onClick={() => act("nextPerformer")}>
            {next ? `Bring up ${next.name} ▶` : "Nobody waiting yet"}
          </button>
        </>
      )}
    </section>
  );
}

interface Drag {
  id: string;
  from: number;
  over: number;
  startY: number;
  dy: number;
  /** Row midpoints (page Y) and heights at the start of the drag. */
  mids: number[];
  height: number;
}

/**
 * The line, with drag to reorder: press the ⠿ handle and drag (mouse, finger or pen; the
 * handle has touch-action: none so the page doesn't scroll). Arrow keys on the handle
 * move one place.
 */
function QueuePanel({ view, skew, act }: { view: RoomView; skew: number; act: Act }) {
  const now = useNow(skew);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The order shown after a drop, until the server's next state arrives.
  const [pending, setPending] = useState<string[] | null>(null);
  const rows = useRef(new Map<string, HTMLLIElement>());
  const queueKey = view.queue.map((e) => e.id).join(",");
  useLayoutEffect(() => setPending(null), [queueKey]);

  const byId = new Map(view.queue.map((e) => [e.id, e]));
  const order = (pending ?? view.queue.map((e) => e.id)).filter((id) => byId.has(id));
  const list = order.map((id) => byId.get(id)!);

  const move = (id: string, toIndex: number) => {
    const ids = order.filter((x) => x !== id);
    ids.splice(toIndex, 0, id);
    setPending(ids);
    act("moveEntry", { entryId: id, toIndex });
  };

  const onDown = (e: RPointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const mids = list.map((x) => {
      const r = rows.current.get(x.id)?.getBoundingClientRect();
      return r ? r.top + r.height / 2 : 0;
    });
    const r = rows.current.get(id)?.getBoundingClientRect();
    setDrag({ id, from: index, over: index, startY: e.clientY, dy: 0, mids, height: r?.height ?? 56 });
  };
  const onMove = (e: RPointerEvent<HTMLButtonElement>) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    const center = drag.mids[drag.from] + dy;
    let over = 0;
    drag.mids.forEach((m, i) => {
      if (i !== drag.from && m < center) over++;
    });
    setDrag({ ...drag, dy, over });
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.over !== drag.from) move(drag.id, drag.over);
    setDrag(null);
  };
  const onKey = (e: KeyboardEvent, id: string, index: number) => {
    if (e.key === "ArrowUp" && index > 0) {
      e.preventDefault();
      move(id, index - 1);
    } else if (e.key === "ArrowDown" && index < list.length - 1) {
      e.preventDefault();
      move(id, index + 1);
    }
  };

  const shift = (i: number): number => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < drag.over && i > drag.from && i <= drag.over) return -drag.height;
    if (drag.from > drag.over && i >= drag.over && i < drag.from) return drag.height;
    return 0;
  };

  return (
    <section className="panel">
      <h2>
        In line <span className="muted">({list.length})</span>
      </h2>
      {list.length === 0 ? (
        <p className="muted">Nobody's waiting.</p>
      ) : (
        <ol className={`queue ${drag ? "dragging" : ""}`}>
          {list.map((e, i) => (
            <li
              key={e.id}
              ref={(el) => {
                if (el) rows.current.set(e.id, el);
                else rows.current.delete(e.id);
              }}
              className={`queue-row ${drag?.id === e.id ? "lifted" : ""}`}
              style={{ transform: `translateY(${drag?.id === e.id ? drag.dy : shift(i)}px)` }}
            >
              <button
                className="handle"
                aria-label={`Move ${e.name}: drag, or use the arrow keys`}
                title="Drag to reorder"
                onPointerDown={(ev) => onDown(ev, e.id, i)}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(ev) => onKey(ev, e.id, i)}
              >
                ⠿
              </button>
              <span className="queue-pos">{i + 1}</span>
              <div className="queue-main">
                <strong>{e.name}</strong>
                <EntryDetail e={e} showNote />
                <span className="muted small">
                  {waitText(view, i + 1, now)}
                  {e.byHost && " · added by hand"}
                </span>
              </div>
              <QueueActions e={e} view={view} act={act} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueActions({ e, view, act }: { e: EntryView; view: RoomView; act: Act }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="queue-actions">
      <button className="btn btn-small btn-secondary" onClick={() => act("nowOn", e.id)} title="Bring them up now">
        Now on
      </button>
      <button className="btn btn-small btn-ghost" onClick={() => act("moveToEnd", e.id)}>
        To end
      </button>
      <button className="btn btn-small btn-ghost" onClick={() => act("skipEntry", e.id)}>
        Skip
      </button>
      <button className="btn btn-small btn-ghost" onClick={() => setEditing(true)}>
        Edit
      </button>
      {editing && (
        <div className="modal" role="dialog" aria-label={`Edit ${e.name}`} onClick={() => setEditing(false)}>
          <div className="panel modal-box" onClick={(ev) => ev.stopPropagation()}>
            <EntryForm
              title={`Edit ${e.name}`}
              karaoke={view.settings.mode === "karaoke"}
              initial={e}
              submitLabel="Save"
              onSubmit={async (input) => {
                const ok = await act("editEntry", { entryId: e.id, ...input });
                if (ok) setEditing(false);
                return Boolean(ok);
              }}
              onCancel={() => setEditing(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/** Name, song and artist (or note), and "with": the host's add and edit form. */
function EntryForm({
  title,
  karaoke,
  initial,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  title: string;
  karaoke: boolean;
  initial?: EntryInput;
  submitLabel: string;
  onSubmit: (e: EntryInput) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [f, setF] = useState<Required<EntryInput>>({
    name: initial?.name ?? "",
    song: initial?.song ?? "",
    artist: initial?.artist ?? "",
    note: initial?.note ?? "",
    with: initial?.with ?? "",
  });
  const set = (k: keyof EntryInput, max: number) => (ev: { target: { value: string } }) =>
    setF({ ...f, [k]: ev.target.value.slice(0, max) });
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const ok = await onSubmit({
      name: f.name.trim(),
      song: f.song.trim(),
      artist: f.artist.trim(),
      note: f.note.trim(),
      with: f.with.trim(),
    });
    if (ok && !initial) setF({ name: "", song: "", artist: "", note: "", with: "" });
  };
  return (
    <form className="entry-form" onSubmit={submit}>
      <h3>{title}</h3>
      <label>
        Name
        <input value={f.name} onChange={set("name", LIMITS.name)} required />
      </label>
      {karaoke && (
        <>
          <label>
            Song
            <input value={f.song} onChange={set("song", LIMITS.song)} />
          </label>
          <label>
            Artist
            <input value={f.artist} onChange={set("artist", LIMITS.artist)} />
          </label>
        </>
      )}
      <label>
        Note (only hosts see it)
        <input value={f.note} onChange={set("note", LIMITS.note)} />
      </label>
      <label>
        With (a duet, group or band)
        <input value={f.with} onChange={set("with", LIMITS.with)} />
      </label>
      <div className="row">
        <button className="btn btn-primary" disabled={!f.name.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn btn-ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function ControlsPanel({ view, act }: { view: RoomView; act: Act }) {
  const [message, setMessage] = useState(view.settings.message);
  // Follow changes made elsewhere (a co-host) when this field isn't being edited.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setMessage(view.settings.message);
  }, [view.settings.message, editing]);
  const open = view.settings.signupsOpen;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    await act("setMessage", message.trim());
    setEditing(false);
  };
  return (
    <section className="panel">
      <h2>Signups</h2>
      <div className="row">
        <span className={`pill ${open ? "pill-on" : "pill-off"}`}>{open ? "Open" : "Paused"}</span>
        <button className={`btn ${open ? "btn-ghost" : "btn-primary"}`} onClick={() => act("setSignupsOpen", !open)}>
          {open ? "Pause signups" : "Open signups"}
        </button>
      </div>
      <p className="muted small">
        While paused, phones can't join the list. You can still add people by hand, and everyone already in line keeps
        their place.
      </p>
      <form className="message-form" onSubmit={save}>
        <label>
          Message to the queue (on the TV and phones)
          <input
            value={message}
            onFocus={() => setEditing(true)}
            onChange={(e) => {
              setEditing(true);
              setMessage(e.target.value.slice(0, LIMITS.message));
            }}
            placeholder="10 minute break"
          />
        </label>
        <div className="row">
          <button className="btn btn-secondary" disabled={message.trim() === view.settings.message}>
            Show message
          </button>
          {view.settings.message && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMessage("");
                setEditing(false);
                act("setMessage", "");
              }}
            >
              Clear
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function AddPanel({ view, act }: { view: RoomView; act: Act }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      {open ? (
        <EntryForm
          title="Add someone by hand"
          karaoke={view.settings.mode === "karaoke"}
          submitLabel="Add to the end of the line"
          onSubmit={async (input) => Boolean(await act("addEntry", input))}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <button className="btn btn-secondary" onClick={() => setOpen(true)}>
          + Add someone by hand
        </button>
      )}
    </section>
  );
}

function InvitePanel({ view }: { view: RoomView }) {
  const venue = useVenue();
  const join = joinDisplay(venue, `/join/${view.code}`, view.code);
  const tvUrl = venueJoinUrl(venue, `/join/${view.code}?as=table`);
  return (
    <section className="panel invite">
      <h2>Sign-up link</h2>
      <div className="invite-row">
        <QrCode text={join.url} size={140} />
        <div>
          <div className="big-code">{view.code}</div>
          <p className="muted small break">{join.roomShort ?? join.url}</p>
          <p className="small">
            <a href={tvUrl} target="_blank" rel="noreferrer">
              Open the TV view ↗
            </a>
          </p>
          <p className="muted small">
            {view.patrons} phone{view.patrons === 1 ? "" : "s"} · {view.tableCount} TV{view.tableCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>
    </section>
  );
}

function HistoryPanel({ view, act }: { view: RoomView; act: Act }) {
  if (view.history.length === 0) return null;
  return (
    <section className="panel">
      <h2>
        Tonight so far <span className="muted">({view.turns} on stage)</span>
      </h2>
      <ul className="history">
        {view.history.map((e) => (
          <li key={e.id}>
            <span className="grow">
              {e.turn ? `#${e.turn} ` : ""}
              <strong>{e.name}</strong> <EntryDetail e={e} />
            </span>
            <span className={`muted small status-${e.status}`}>{STATUS_LABEL[e.status]}</span>
            <button className="btn btn-small btn-ghost" onClick={() => act("restoreEntry", e.id)} title="Back in line, at the end">
              Put back
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SettingsPanel({ view, act }: { view: RoomView; act: Act }) {
  const s = view.settings;
  const update = (patch: Partial<RoomSettings>) => act("updateSettings", patch);
  const num = (k: "maxPerNight" | "minutesPerTurn" | "tvNextCount", { min, max }: { min: number; max: number }) => (
    <select value={s[k]} onChange={(e) => update({ [k]: Number(e.target.value) })}>
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
        <option key={n} value={n}>
          {k === "maxPerNight" && n === 0 ? "No limit" : n}
        </option>
      ))}
    </select>
  );
  return (
    <section className="panel">
      <h2>Settings</h2>
      <div className="seg" role="radiogroup" aria-label="Kind of night">
        <button role="radio" aria-checked={s.mode === "karaoke"} className={s.mode === "karaoke" ? "on" : ""} onClick={() => update({ mode: "karaoke" })}>
          🎤 Karaoke
        </button>
        <button role="radio" aria-checked={s.mode === "openmic"} className={s.mode === "openmic" ? "on" : ""} onClick={() => update({ mode: "openmic" })}>
          🎸 Open mic
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.oneActive} onChange={(e) => update({ oneActive: e.target.checked })} />
        One signup per phone at a time
      </label>
      <label className="inline">
        Most signups per phone tonight {num("maxPerNight", LIMITS.maxPerNight)}
      </label>
      <label className="inline">
        Minutes per turn (for the wait estimate) {num("minutesPerTurn", LIMITS.minutesPerTurn)}
      </label>
      <label className="inline">
        Next performers on the TV {num("tvNextCount", LIMITS.tvNextCount)}
      </label>
    </section>
  );
}

/** Co-hosts (the kit's HostSeats): a single-use invite QR that expires, and the co-host list. */
function CohostsPanel({ view, act }: { view: RoomView; act: Act }) {
  const venue = useVenue();
  const [invite, setInvite] = useState<{ url: string; expiresAt: string; count: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const count = view.cohosts.length;
  const expired = invite ? Date.parse(invite.expiresAt) <= now : false;
  useEffect(() => {
    if (!invite) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [invite]);
  useEffect(() => {
    if (invite && count > invite.count) setInvite(null);
  }, [count, invite]);
  const add = async () => {
    const res = await act<{ path: string; expiresAt: string }>("cohostInvite");
    if (!res) return;
    setNow(Date.now());
    setInvite({ url: venueJoinUrl(venue, res.path), expiresAt: res.expiresAt, count });
  };
  const until = invite ? new Date(invite.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
  return (
    <section className="panel">
      <h2>
        Co-hosts <span className="muted">({count})</span>
      </h2>
      <p className="muted small">A co-host runs the list with you, but can't close it or invite others.</p>
      {invite && !expired ? (
        <div className="invite-row">
          <QrCode text={invite.url} size={160} />
          <div>
            <p>Scan with the co-host's phone.</p>
            <p className="muted small">Works once, until {until}.</p>
            <button className="btn btn-ghost btn-small" onClick={() => setInvite(null)}>
              Hide
            </button>
          </div>
        </div>
      ) : (
        <button className="btn btn-secondary" onClick={add}>
          {expired ? "That code expired: make a new one" : "Add a co-host"}
        </button>
      )}
      {count > 0 && (
        <ul className="people">
          {view.cohosts.map((c) => (
            <li key={c.id}>
              <span className={`dot ${c.connected ? "on" : ""}`} title={c.connected ? "Connected" : "Disconnected"} />
              <span className="grow">
                {c.name} <span className="badge">Co-host</span>
              </span>
              <button
                className="btn btn-small btn-ghost"
                onClick={() => window.confirm(`Remove ${c.name} as a co-host?`) && act("removeCohost", c.id)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
