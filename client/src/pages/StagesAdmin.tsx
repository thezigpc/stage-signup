import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { joinUrl } from "@bargames/sdk/client";
import { LIMITS, type AdminStages, type StageConfig } from "@signup/shared";
import { useVenue } from "../useVenue";

type AdminApi = <T>(path: string, token: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** The stages: staff set them up here. Guests run the list on /kj but never get here. */
export function StagesAdmin({
  token,
  api,
  onSignOut,
  onExpired,
}: {
  token: string;
  api: AdminApi;
  onSignOut: () => void;
  onExpired: () => void;
}) {
  const venue = useVenue();
  const [stages, setStages] = useState<StageConfig[] | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [newName, setNewName] = useState("");

  const call = useCallback(
    async (path: string, init: { method?: string; body?: unknown } = {}) => {
      try {
        const r = await api<AdminStages>(path, token, init);
        setStages(r.stages);
        setError("");
        return true;
      } catch (err) {
        if ((err as { status?: number }).status === 401) onExpired();
        else setError((err as Error).message);
        return false;
      }
    },
    [api, token, onExpired],
  );
  useEffect(() => {
    void call("/stages");
  }, [call]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setNote("");
    const name = newName.trim();
    if (await call("/stages", { method: "POST", body: { name } })) {
      setNote(`Added ${name}.`);
      setNewName("");
    }
  };
  const move = (i: number, by: number) => {
    if (!stages) return;
    const ids = stages.map((s) => s.id);
    const [id] = ids.splice(i, 1);
    ids.splice(i + by, 0, id);
    void call("/stage-order", { method: "PUT", body: { ids } });
  };

  return (
    <>
      {error && <p className="error">{error}</p>}
      {note && <p className="note">{note}</p>}

      <section className="panel">
        <h2>Run the list</h2>
        <p className="muted small">
          Staff run it from the host screen. A guest host (a patron running karaoke tonight) gets a guest link from the
          venue box admin instead, and can't change anything on this page.
        </p>
        <Link className="btn btn-primary" to="/kj">
          Open the host screen
        </Link>
      </section>

      <h2 className="section-title">
        Stages <span className="muted">({stages?.length ?? "…"})</span>
      </h2>
      <p className="muted small">
        Each stage has its own list and its own "Up next" TV view. With one stage on, patrons never see a stage picker.
      </p>
      {stages?.map((s, i) => (
        <StageEditor
          key={s.id}
          stage={s}
          first={i === 0}
          last={i === stages.length - 1}
          only={stages.length === 1}
          tvUrl={joinUrl(venue, `/tv?stage=${encodeURIComponent(s.id)}`)}
          onSave={(patch) => call(`/stages/${encodeURIComponent(s.id)}`, { method: "PUT", body: patch })}
          onDelete={() => {
            if (window.confirm(`Remove ${s.name}? Its list goes too.`)) void call(`/stages/${encodeURIComponent(s.id)}`, { method: "DELETE" });
          }}
          onMove={(by) => move(i, by)}
        />
      ))}
      {stages && stages.length < LIMITS.stages && (
        <form className="panel admin-form" onSubmit={add}>
          <label>
            Add a stage
            <input value={newName} onChange={(e) => setNewName(e.target.value.slice(0, LIMITS.stageName))} placeholder="Back room" />
          </label>
          <button className="btn btn-secondary" disabled={!newName.trim()}>
            Add
          </button>
        </form>
      )}

      <button className="btn btn-ghost" onClick={onSignOut}>
        Sign out
      </button>
    </>
  );
}

function StageEditor({
  stage,
  first,
  last,
  only,
  tvUrl,
  onSave,
  onDelete,
  onMove,
}: {
  stage: StageConfig;
  first: boolean;
  last: boolean;
  only: boolean;
  tvUrl: string;
  onSave: (patch: Partial<StageConfig>) => Promise<boolean>;
  onDelete: () => void;
  onMove: (by: number) => void;
}) {
  const [name, setName] = useState(stage.name);
  useEffect(() => setName(stage.name), [stage.name]);
  const save = (patch: Partial<StageConfig>) => void onSave(patch);
  const num = (k: "maxPerNight" | "minutesPerTurn" | "tvNextCount", { min, max }: { min: number; max: number }) => (
    <select value={stage[k]} onChange={(e) => save({ [k]: Number(e.target.value) })}>
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((n) => (
        <option key={n} value={n}>
          {k === "maxPerNight" && n === 0 ? "No limit" : n}
        </option>
      ))}
    </select>
  );
  return (
    <section className={`panel stage-editor ${stage.enabled ? "" : "is-off"}`}>
      <div className="row spread">
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && name.trim() !== stage.name) save({ name: name.trim() });
          }}
        >
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, LIMITS.stageName))}
            aria-label="Stage name"
            className="grow stage-name-input"
          />
          {name.trim() !== stage.name && (
            <button className="btn btn-small btn-secondary" disabled={!name.trim()}>
              Rename
            </button>
          )}
        </form>
        <div className="row">
          <button className="btn btn-small btn-ghost" disabled={first} onClick={() => onMove(-1)} aria-label={`Move ${stage.name} up`}>
            ↑
          </button>
          <button className="btn btn-small btn-ghost" disabled={last} onClick={() => onMove(1)} aria-label={`Move ${stage.name} down`}>
            ↓
          </button>
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={stage.enabled} onChange={(e) => save({ enabled: e.target.checked })} />
        On (patrons can sign up)
      </label>
      <div className="seg" role="radiogroup" aria-label="Kind of night">
        <button role="radio" aria-checked={stage.mode === "karaoke"} className={stage.mode === "karaoke" ? "on" : ""} onClick={() => save({ mode: "karaoke" })}>
          🎤 Karaoke
        </button>
        <button role="radio" aria-checked={stage.mode === "openmic"} className={stage.mode === "openmic" ? "on" : ""} onClick={() => save({ mode: "openmic" })}>
          🎸 Open mic
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={stage.oneActive} onChange={(e) => save({ oneActive: e.target.checked })} />
        One signup per phone at a time
      </label>
      <label className="inline">Most signups per phone per night {num("maxPerNight", LIMITS.maxPerNight)}</label>
      <label className="inline">Minutes per turn (for the wait estimate) {num("minutesPerTurn", LIMITS.minutesPerTurn)}</label>
      <label className="inline">Next performers on the TV {num("tvNextCount", LIMITS.tvNextCount)}</label>
      <div className="row">
        <Link className="btn btn-small btn-secondary" to={`/kj?stage=${encodeURIComponent(stage.id)}`}>
          Run this list
        </Link>
        <a className="btn btn-small btn-ghost" href={tvUrl} target="_blank" rel="noreferrer">
          TV view ↗
        </a>
        {!only && (
          <button className="btn btn-small btn-danger" onClick={onDelete}>
            Remove
          </button>
        )}
      </div>
      <p className="muted small break">TV address: {tvUrl}</p>
    </section>
  );
}
