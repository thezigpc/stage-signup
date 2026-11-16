import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent as RPointerEvent } from "react";
import { joinDisplay, joinUrl as venueJoinUrl } from "@bargames/sdk/client";
import { LIMITS, type CohostLink, type EntryInput, type EntryView, type RunnerInfo, type StageView } from "@signup/shared";
import { api } from "../api";
import { EntryDetail, STATUS_LABEL, useNow, waitText } from "../components/bits";
import { QrCode } from "../components/QrCode";
import { useVenue } from "../useVenue";

/** Runs one list action over /api/run (checked server-side every time). Null when refused. */
export type Run = (action: string, body?: Record<string, unknown>) => Promise<Record<string, unknown> | null>;

/**
 * Running the list: staff, a guest host or a guest co-host. The stage's setup (name, mode,
 * limits) is on the admin page, staff only.
 */
export function HostView({
  view,
  skew,
  run,
  me,
  onError,
}: {
  view: StageView;
  skew: number;
  run: Run;
  me: RunnerInfo;
  onError: (msg: string) => void;
}) {
  return (
    <main className="host">
      {!view.stage.enabled && (
        <p className="warning">This stage is turned off: patrons can't see it. Staff turn it on in the admin page.</p>
      )}
      <NowPanel view={view} skew={skew} run={run} />
      <QueuePanel view={view} skew={skew} run={run} />
      <ControlsPanel view={view} run={run} />
      <AddPanel view={view} run={run} />
      <InvitePanel view={view} />
      <HistoryPanel view={view} run={run} />
      {me.canAddCohosts && <CohostsPanel onError={onError} />}
      <NightPanel view={view} run={run} />
    </main>
  );
}

function minutesSince(at: number | undefined, now: number): string {
  if (!at) return "";
  const m = Math.max(0, Math.floor((now - at) / 60_000));
  return m < 1 ? "just now" : `${m} min`;
}

function NowPanel({ view, skew, run }: { view: StageView; skew: number; run: Run }) {
  const now = useNow(skew, 30_000);
  const cur = view.now;
  const next = view.queue[0];
  return (
    <section className="panel now-panel host-now">
      <h2 className="eyebrow">{view.stage.name}: on stage now</h2>
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
            <button className="btn btn-primary btn-big grow" onClick={() => run("next")}>
              {next ? `Next: ${next.name} ▶` : "Done, nobody waiting"}
            </button>
          </div>
          <div className="row">
            <button className="btn btn-secondary" onClick={() => run("done")} title="Done; the stage stays empty">
              ✓ Done
            </button>
            <button className="btn btn-ghost" onClick={() => run("skip", { entryId: cur.id })} title="A no-show: out of the line">
              Skip
            </button>
            <button className="btn btn-ghost" onClick={() => run("to-end", { entryId: cur.id })} title="Back in line, at the end">
              Move to end
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Nobody's on stage.</p>
          <button className="btn btn-primary btn-big" disabled={!next} onClick={() => run("next")}>
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
  /** Row midpoints (client Y) and the dragged row's height at the start of the drag. */
  mids: number[];
  height: number;
}

/**
 * The line, with drag to reorder: press the ⠿ handle and drag (mouse, finger or pen; the
 * handle has touch-action: none so the page doesn't scroll). Arrow keys on the handle move
 * one place.
 */
function QueuePanel({ view, skew, run }: { view: StageView; skew: number; run: Run }) {
  const now = useNow(skew);
  const [drag, setDrag] = useState<Drag | null>(null);
  // The order shown after a drop, until the server's next view arrives.
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
    void run("move", { entryId: id, toIndex }).then((r) => r === null && setPending(null));
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
        In line <span className="muted">({list.length} waiting)</span>
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
              <QueueActions e={e} view={view} run={run} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function QueueActions({ e, view, run }: { e: EntryView; view: StageView; run: Run }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="queue-actions">
      <button className="btn btn-small btn-secondary" onClick={() => run("now-on", { entryId: e.id })} title="Bring them up now">
        Now on
      </button>
      <button className="btn btn-small btn-ghost" onClick={() => run("to-end", { entryId: e.id })}>
        To end
      </button>
      <button className="btn btn-small btn-ghost" onClick={() => run("skip", { entryId: e.id })}>
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
              karaoke={view.stage.mode === "karaoke"}
              initial={e}
              submitLabel="Save"
              onSubmit={async (input) => {
                const ok = await run("edit", { entryId: e.id, ...input });
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

/** Name, song and artist, a note, and "with": the add and edit form. */
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

function ControlsPanel({ view, run }: { view: StageView; run: Run }) {
  const [message, setMessage] = useState(view.live.message);
  // Follow changes made elsewhere (a co-host) while this field isn't being edited.
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setMessage(view.live.message);
  }, [view.live.message, editing]);
  const open = view.live.signupsOpen;
  const save = async (ev: FormEvent) => {
    ev.preventDefault();
    await run("message", { message: message.trim() });
    setEditing(false);
  };
  return (
    <section className="panel">
      <h2>Signups</h2>
      <div className="row">
        <span className={`pill ${open ? "pill-on" : "pill-off"}`}>{open ? "Open" : "Paused"}</span>
        <button className={`btn ${open ? "btn-ghost" : "btn-primary"}`} onClick={() => run("signups", { open: !open })}>
          {open ? "Pause signups" : "Open signups"}
        </button>
      </div>
      <p className="muted small">
        While paused, phones see "Signups are paused". You can still add people by hand, and everyone in line keeps their
        place.
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
          <button className="btn btn-secondary" disabled={message.trim() === view.live.message}>
            Show message
          </button>
          {view.live.message && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setMessage("");
                setEditing(false);
                void run("message", { message: "" });
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

function AddPanel({ view, run }: { view: StageView; run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel">
      {open ? (
        <EntryForm
          title="Add a walk-up"
          karaoke={view.stage.mode === "karaoke"}
          submitLabel="Add to the end of the line"
          onSubmit={async (input) => Boolean(await run("add", input as Record<string, unknown>))}
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

function InvitePanel({ view }: { view: StageView }) {
  const venue = useVenue();
  const join = joinDisplay(venue, `/?stage=${encodeURIComponent(view.stage.id)}`);
  const tvUrl = venueJoinUrl(venue, `/tv?stage=${encodeURIComponent(view.stage.id)}`);
  return (
    <section className="panel invite">
      <h2>Sign-up link</h2>
      <div className="invite-row">
        <QrCode text={join.url} size={140} />
        <div>
          <p className="muted small break">{join.short}</p>
          <p className="small">
            <a href={tvUrl} target="_blank" rel="noreferrer">
              Open this stage's TV view ↗
            </a>
          </p>
        </div>
      </div>
    </section>
  );
}

function HistoryPanel({ view, run }: { view: StageView; run: Run }) {
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
            <button className="btn btn-small btn-ghost" onClick={() => run("restore", { entryId: e.id })} title="Back in line, at the end">
              Put back
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "New night": clears this stage's list (it replaces closing a room). */
function NightPanel({ view, run }: { view: StageView; run: Run }) {
  const started = new Date(view.nightStartedAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  const count = view.queue.length + view.history.length + (view.now ? 1 : 0);
  return (
    <section className="panel">
      <h2>New night</h2>
      <p className="muted small">
        Clears {view.stage.name}'s list, tonight's history and the per-phone counts, and opens signups. This list started{" "}
        {started}.
      </p>
      <button
        className="btn btn-danger"
        onClick={() =>
          window.confirm(`Start a new night on ${view.stage.name}? ${count ? `The ${count} signup${count === 1 ? "" : "s"} on the list go.` : ""}`) &&
          run("new-night")
        }
      >
        Start a new night
      </button>
    </section>
  );
}

/**
 * A guest host's co-hosts (SDK 0.16.0): the box makes the link; show it as a QR to the
 * co-host only. The venue has to allow co-hosts for this app; the box's refusal is shown as-is.
 */
function CohostsPanel({ onError }: { onError: (msg: string) => void }) {
  const [cohosts, setCohosts] = useState<CohostLink[]>([]);
  const [name, setName] = useState("");
  const [invite, setInvite] = useState<{ url: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<{ cohosts: CohostLink[] }>("/api/run/cohosts")
      .then((r) => setCohosts(r.cohosts))
      .catch(() => {});
  }, []);
  useEffect(load, [load]);

  const add = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ url: string; label: string }>("/api/run/cohosts", { body: { name: name.trim() } });
      setInvite({ url: r.url, label: r.label });
      setName("");
      load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "The box refused.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: CohostLink) => {
    if (!window.confirm(`Remove ${c.label}? Their link stops working.`)) return;
    try {
      await api(`/api/run/cohosts/${encodeURIComponent(c.id)}`, { method: "DELETE" });
      load();
    } catch (e) {
      onError(e instanceof Error ? e.message : "The box refused.");
    }
  };

  return (
    <section className="panel">
      <h2>
        Co-hosts <span className="muted">({cohosts.length})</span>
      </h2>
      <p className="muted small">A co-host runs the list with you. Their link ends when yours does.</p>
      {invite ? (
        <div className="invite-row">
          <QrCode text={invite.url} size={180} />
          <div>
            <p>
              Scan with <strong>{invite.label}</strong>'s phone.
            </p>
            <p className="muted small">Show this to your co-host only.</p>
            <button className="btn btn-ghost btn-small" onClick={() => setInvite(null)}>
              Hide
            </button>
          </div>
        </div>
      ) : (
        <form className="row" onSubmit={add}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, LIMITS.cohostName))}
            placeholder="Co-host's name"
            aria-label="Co-host's name"
            className="grow"
          />
          <button className="btn btn-secondary" disabled={busy || !name.trim()}>
            Add co-host
          </button>
        </form>
      )}
      {cohosts.length > 0 && (
        <ul className="people">
          {cohosts.map((c) => (
            <li key={c.id}>
              <span className="grow">
                {c.label} <span className="badge">Co-host</span>
              </span>
              <button className="btn btn-small btn-ghost" onClick={() => remove(c)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
