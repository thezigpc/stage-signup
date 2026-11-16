import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isOnBox, tableMode, type TableModeController } from "@bargames/sdk/client";
import { useStage } from "../useStage";
import { useVenue } from "../useVenue";
import { TableView } from "./TableView";

/**
 * /tv?stage=<id>: a stage's "Up next" screen. The box casts it, uses it as an idle screen or
 * starts it from a scene, so the URL alone shows it: no prompt, no gesture. A missing or
 * unknown stage shows the first stage that's on.
 */
export function TvPage() {
  const [search] = useSearchParams();
  const asked = search.get("stage") ?? "";
  // A stage turned off or removed mid-show: fall back to the first stage that is on.
  const [fallback, setFallback] = useState(false);
  const stage = fallback ? "" : asked;
  const { view, status, gone } = useStage(stage, "tv");
  useEffect(() => {
    if (gone && stage !== "") setFallback(true);
  }, [gone, stage]);
  // Nothing on at all: try again now and then (staff may turn a stage back on).
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!gone || stage !== "") return;
    const t = setTimeout(() => {
      setFallback(false);
      setTick((n) => n + 1);
    }, 30_000);
    return () => clearTimeout(t);
  }, [gone, stage]);
  const venue = useVenue();
  const onBox = isOnBox(venue);

  // On a box: the SDK's tableMode hides the pointer, keeps the screen awake, sets the safe
  // margins and shows the standard reconnecting banner. Off a box nothing.
  const tm = useRef<TableModeController | null>(null);
  useEffect(() => {
    if (!onBox) return;
    tm.current = tableMode(venue);
    return () => {
      tm.current?.stop();
      tm.current = null;
    };
    // tableMode only needs the venue once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onBox]);
  useEffect(() => {
    tm.current?.setState(status === "offline" ? "reconnecting" : "connected");
  }, [status, onBox]);

  if (gone) {
    return (
      <div className="tv tv-blank">
        <p className="tv-now-empty">{gone}</p>
      </div>
    );
  }
  if (!view) return <div className="tv tv-blank" />;
  return (
    <>
      {status !== "online" && !onBox && (
        <div className="banner banner-float" role="status">
          Connection lost. Reconnecting…
        </div>
      )}
      <TableView view={view} />
    </>
  );
}
