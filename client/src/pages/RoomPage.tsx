import { useCallback, useEffect, useRef, useState } from "react";
import { useRoomConnection } from "@bargames/gamekit/client";
import { isOnBox, markSharedScreen, tableMode, type TableModeController } from "@bargames/sdk/client";
import type { RoomView } from "@signup/shared";
import { Link, useNavigate, useParams } from "react-router-dom";
import { toggleFullscreen } from "../fullscreen";
import { call, socket } from "../socket";
import { clearSession, sessions, type StoredSession } from "../session";
import { useVenue } from "../useVenue";
import { HostView } from "./HostView";
import { PatronView } from "./PatronView";
import { TableView } from "./TableView";

/** Runs a server intent, surfacing a rejection as a short-lived toast. */
export function useAction() {
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);
  const act = useCallback(async <T = object,>(event: Parameters<typeof call>[0], ...args: unknown[]) => {
    try {
      return await call<T>(event, ...args);
    } catch (err) {
      setToast(err instanceof Error ? err.message : "Something went wrong.");
      return null;
    }
  }, []);
  return { act, toast, setToast };
}

export type Act = ReturnType<typeof useAction>["act"];

export function RoomPage() {
  const { code = "" } = useParams();
  const navigate = useNavigate();
  const upper = code.toUpperCase();
  // Re-sends `resume` on EVERY socket connect (socket.io reconnects with a fresh socket).
  const { view, status, closedReason, skew, reconnect } = useRoomConnection<RoomView, StoredSession>(upper, {
    socket: socket as unknown as Parameters<typeof useRoomConnection>[1]["socket"],
    call,
    sessions,
    // The host link's key resumes the host seat and the ack returns that seat's own token:
    // keep it, so a later take-over (a new key) leaves this phone seated as a co-host.
    onResumed: (ack, session) =>
      sessions.save({
        ...session,
        token: typeof ack.token === "string" ? ack.token : session.token,
        name: typeof ack.name === "string" ? ack.name : session.name,
        role: typeof ack.role === "string" ? (ack.role as StoredSession["role"]) : session.role,
      }),
  });
  const { act, toast, setToast } = useAction();
  useEffect(() => {
    const onNotice = (n: { message: string }) => setToast(n.message);
    socket.on("notice", onNotice);
    return () => {
      socket.off("notice", onNotice);
    };
  }, [setToast]);

  // A box TV: the SDK's tableMode hides the pointer, keeps the screen awake, sets the 5% safe
  // margins (--bg-safe-x/y) and shows the standard reconnecting / closed banner. Off a box nothing.
  const venue = useVenue();
  const role = view?.you.role;
  const onBox = isOnBox(venue);
  const boxTv = onBox && role === "table";
  const tm = useRef<TableModeController | null>(null);
  useEffect(() => {
    if (!boxTv) return;
    tm.current = tableMode(venue);
    return () => {
      tm.current?.stop();
      tm.current = null;
    };
    // tableMode only needs the venue once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxTv]);
  useEffect(() => {
    tm.current?.setState(closedReason ? "closed" : status === "offline" ? "reconnecting" : "connected", closedReason ?? undefined);
  }, [boxTv, status, closedReason]);
  // A TV that isn't a box TV (a laptop on a TV) is a shared screen too: the strip follows "show".
  const sharedScreen = onBox && !boxTv && role === "table";
  useEffect(() => (sharedScreen ? markSharedScreen() : undefined), [sharedScreen]);

  if (closedReason) {
    return (
      <main className="center-page">
        <div className="panel">
          <h2>List closed</h2>
          <p>{closedReason}</p>
          <Link className="btn btn-primary" to="/">
            Back to home
          </Link>
        </div>
      </main>
    );
  }

  if (!view) {
    return (
      <main className="center-page">
        <p className="muted">Connecting to {upper}…</p>
      </main>
    );
  }

  if (role === "table") {
    return (
      <>
        {status !== "online" && !boxTv && (
          <div className="banner banner-float" role="status">
            Connection lost. Reconnecting…
          </div>
        )}
        <TableView view={view} skew={skew} />
      </>
    );
  }

  const runner = role === "host" || role === "cohost";
  const leave = async () => {
    if (role === "host") {
      if (!window.confirm("Close tonight's list for everyone? The queue is lost.")) return;
      await call("closeRoom").catch(() => {});
    } else {
      const msg =
        role === "patron" ? "Leave this page? You keep your place in line; come back with the room code." : "Leave?";
      if (!window.confirm(msg)) return;
      await call("leaveRoom").catch(() => {});
    }
    clearSession();
    navigate("/");
  };

  return (
    <div className={`room role-${role}`}>
      {status !== "online" && (
        <div className="banner" role="status">
          {status === "offline" ? "Connection lost. Reconnecting…" : "Connecting…"}
        </div>
      )}
      <header className="room-header">
        <div className="room-id">
          <span className="room-code">{view.code}</span>
          <span className="muted small">
            {view.title ?? (view.settings.mode === "karaoke" ? "Karaoke" : "Open mic")}
          </span>
          {role === "cohost" && <span className="badge">Co-host</span>}
          {role === "host" && <span className="badge">Host</span>}
        </div>
        <div className="header-actions">
          <button className="icon-btn" onClick={toggleFullscreen} title="Full screen" aria-label="Full screen">
            ⛶
          </button>
          <button className="icon-btn" onClick={reconnect} title="Reconnect" aria-label="Reconnect">
            ⟳
          </button>
          <button
            className="icon-btn"
            onClick={leave}
            title={role === "host" ? "Close the list" : "Leave"}
            aria-label={role === "host" ? "Close the list" : "Leave"}
          >
            ✕
          </button>
        </div>
      </header>
      {runner ? <HostView view={view} skew={skew} act={act} /> : <PatronView view={view} skew={skew} act={act} />}
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}
