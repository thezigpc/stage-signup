import { useEffect, useRef, useState } from "react";
import type { StageView, ViewerRole } from "@signup/shared";
import { call, socket } from "./socket";

export type ConnStatus = "connecting" | "online" | "offline";

/**
 * Keeps this page watching one stage: sends `watch` on EVERY socket connect (socket.io's
 * reconnect gives the server a fresh socket that watches nothing) and follows its views.
 * `onWatched` runs after each successful watch (the host page renews its lease there).
 */
export function useStage(stage: string | undefined, role: ViewerRole, device?: string, onWatched?: (stageId: string) => void) {
  const [view, setView] = useState<StageView | null>(null);
  const [status, setStatus] = useState<ConnStatus>(socket.connected ? "online" : "connecting");
  const [gone, setGone] = useState<string | null>(null);
  const [skew, setSkew] = useState(0);
  const watchedRef = useRef(onWatched);
  watchedRef.current = onWatched;

  useEffect(() => {
    if (stage === undefined) return;
    setGone(null);
    setView(null);
    const watch = () => {
      call<{ stage: string }>("watch", { stage, role, device })
        .then((r) => {
          setStatus("online");
          watchedRef.current?.(r.stage);
        })
        .catch((err: Error) => setGone(err.message));
    };
    const onConnect = () => watch();
    const onDisconnect = () => setStatus("offline");
    const onState = (v: StageView) => {
      setView(v);
      setSkew(v.serverTime - Date.now());
    };
    const onGone = (p: { reason: string }) => setGone(p.reason);
    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("state", onState);
    socket.on("gone", onGone);
    if (socket.connected) watch();
    else socket.connect();
    const onOnline = () => !socket.connected && socket.connect();
    window.addEventListener("online", onOnline);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("state", onState);
      socket.off("gone", onGone);
      window.removeEventListener("online", onOnline);
    };
  }, [stage, role, device]);

  const reconnect = () => {
    socket.disconnect();
    socket.connect();
  };
  return { view, status, gone, skew, reconnect };
}
