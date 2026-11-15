import { useEffect, useState } from "react";
import { estimatedWait, type EntryView, type RoomView } from "@signup/shared";

/** The local clock, ticking every `ms` (server-corrected with `skew`). */
export function useNow(skew: number, ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now() + skew);
  useEffect(() => {
    setNow(Date.now() + skew);
    const t = setInterval(() => setNow(Date.now() + skew), ms);
    return () => clearInterval(t);
  }, [skew, ms]);
  return now;
}

/** "about 12 min" for the entry at `position` in line (1 = next). */
export function waitText(view: RoomView, position: number, now: number): string {
  if (position === 1 && !view.now) return "you're next";
  const min = estimatedWait(position, view.settings.minutesPerTurn, view.now?.startedAt, now);
  return `about ${min} min`;
}

/** Song and artist (karaoke), the "with" names, and (for the host) the note. */
export function EntryDetail({ e, showNote = false }: { e: EntryView; showNote?: boolean }) {
  const song = e.song ? (e.artist ? `${e.song} · ${e.artist}` : e.song) : e.artist;
  return (
    <>
      {song && <span className="entry-song">{song}</span>}
      {e.with && <span className="entry-with">with {e.with}</span>}
      {showNote && e.note && <span className="entry-note">“{e.note}”</span>}
    </>
  );
}

export const STATUS_LABEL: Record<EntryView["status"], string> = {
  waiting: "In line",
  up: "On stage",
  done: "Done",
  skipped: "Skipped",
  dropped: "Dropped out",
};
