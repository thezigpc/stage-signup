import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { RunnerInfo } from "@signup/shared";
import { api, ApiError } from "../api";
import { toggleFullscreen } from "../fullscreen";
import { lastRunStage, rememberRunStage } from "../session";
import { socket } from "../socket";
import { useGameName } from "../useGameName";
import { useStage } from "../useStage";
import { useToast } from "../useToast";
import { HostView, type Run } from "./HostView";

type Me = RunnerInfo & { stages: { id: string; name: string; enabled: boolean }[] };

/** How often the page proves it may still run the list (the server's lease is 150 s). */
const LEASE_EVERY_MS = 60_000;

/**
 * /kj: running the list. Staff (signed in on /admin, or box staff) or a guest host or
 * co-host from the box's guest link. Who may is asked of the server, never assumed.
 */
export function KjPage() {
  const gameName = useGameName();
  const [me, setMe] = useState<Me | null>(null);
  const [denied, setDenied] = useState("");
  const [search, setSearch] = useSearchParams();

  const loadMe = useCallback(() => {
    api<Me>("/api/run/me")
      .then((m) => {
        setMe(m);
        setDenied("");
      })
      .catch((e: Error) => setDenied(e.message));
  }, []);
  useEffect(loadMe, [loadMe]);

  if (denied) {
    return (
      <main className="center-page">
        <div className="panel">
          <h2>Running the list</h2>
          <p>{denied}</p>
          <p className="muted small">
            Staff: sign in on the <Link to="/admin">admin page</Link>, then come back here.
          </p>
          <button className="btn btn-ghost" onClick={loadMe}>
            Try again
          </button>
        </div>
      </main>
    );
  }
  if (!me) return <p className="muted page-pad">Loading…</p>;

  const asked = search.get("stage") ?? lastRunStage();
  const stage = me.stages.find((s) => s.id === asked) ?? me.stages.find((s) => s.enabled) ?? me.stages[0];
  const choose = (id: string) => {
    rememberRunStage(id);
    setSearch({ stage: id }, { replace: true });
  };

  return (
    <div className="page-kj">
      <header className="room-header">
        <div className="room-id">
          <span className="app-title">{gameName}</span>
          {me.kind === "guest" && <span className="badge">{me.guest?.role === "cohost" ? "Co-host" : "Guest host"}</span>}
          {me.kind === "staff" && <span className="badge">Staff</span>}
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
            ⛶
          </button>
        </div>
      </header>
      {me.stages.length > 1 && (
        <nav className="stage-tabs" aria-label="Stages">
          {me.stages.map((s) => (
            <button key={s.id} className={s.id === stage?.id ? "on" : ""} onClick={() => choose(s.id)}>
              {s.name}
              {!s.enabled && " (off)"}
            </button>
          ))}
        </nav>
      )}
      {stage ? <RunStage key={stage.id} stageId={stage.id} me={me} onDenied={setDenied} /> : <p className="page-pad">No stages yet.</p>}
    </div>
  );
}

function RunStage({ stageId, me, onDenied }: { stageId: string; me: Me; onDenied: (msg: string) => void }) {
  const { toast, setToast } = useToast();

  // The runner's view (notes, history) comes over the socket only while this page holds a
  // lease, renewed through /api/run, where staff or the guest link is checked every time.
  const lease = useCallback(
    (id: string) => {
      if (!socket.id) return;
      api("/api/run/lease", { body: { stage: id, socketId: socket.id } }).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) onDenied(e.message);
      });
    },
    [onDenied],
  );
  const { view, status, skew } = useStage(stageId, "runner", undefined, lease);
  useEffect(() => {
    const t = setInterval(() => lease(stageId), LEASE_EVERY_MS);
    return () => clearInterval(t);
  }, [lease, stageId]);

  const run: Run = useCallback(
    async (action, body) => {
      try {
        return await api<Record<string, unknown>>(`/api/run/${encodeURIComponent(stageId)}/${action}`, { body: body ?? {} });
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) onDenied(e.message);
        else setToast(e instanceof Error ? e.message : "Something went wrong.");
        return null;
      }
    },
    [stageId, onDenied, setToast],
  );

  if (!view) return <p className="muted page-pad">Connecting…</p>;
  return (
    <>
      {status !== "online" && (
        <div className="banner" role="status">
          Connection lost. Reconnecting…
        </div>
      )}
      <HostView view={view} skew={skew} run={run} me={me} onError={setToast} />
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
