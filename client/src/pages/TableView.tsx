import { useEffect } from "react";
import { isOnBox, joinDisplay } from "@bargames/sdk/client";
import { JoinAddress } from "@bargames/gamekit/client";
import type { StageView } from "@signup/shared";
import { EntryDetail } from "../components/bits";
import { QrCode } from "../components/QrCode";
import { useGameName } from "../useGameName";
import { useVenue } from "../useVenue";

/**
 * Keeps a TV/laptop display awake. Off on a box TV: the SDK's tableMode holds the wake lock.
 */
function useWakeLock(off: boolean) {
  useEffect(() => {
    if (off) return;
    type WL = { release: () => Promise<void> };
    const nav = navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<WL> } };
    let lock: WL | null = null;
    const acquire = () =>
      nav.wakeLock
        ?.request("screen")
        .then((l) => (lock = l))
        .catch(() => {});
    acquire();
    const onVis = () => document.visibilityState === "visible" && acquire();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, [off]);
}

/**
 * The TV: who's on now, the next few, the join QR and short room link, the host's message.
 * Built for 1080p seen across a room: fills the screen, never scrolls, no buttons, sized in vh.
 * Static: it only changes when the list does.
 */
export function TableView({ view }: { view: StageView }) {
  const gameName = useGameName();
  const venue = useVenue();
  const onBox = isOnBox(venue);
  useWakeLock(onBox);
  const logo = onBox ? venue.game.theme.logoUrl : undefined;
  // The patron page for this stage (with one stage the param is simply ignored).
  const join = joinDisplay(venue, `/?stage=${encodeURIComponent(view.stage.id)}`);
  const next = view.queue.slice(0, view.config.tvNextCount);
  const more = view.queue.length - next.length;
  const karaoke = view.stage.mode === "karaoke";

  return (
    <div className="tv">
      <header className="tv-top">
        {logo && <img className="tv-logo" src={logo} alt="" />}
        <h1 className="tv-title">{view.stage.name}</h1>
        <span className="tv-app">{gameName}</span>
        {!view.live.signupsOpen && <span className="tv-paused">Signups paused</span>}
      </header>

      {view.live.message && <div className="tv-message">📣 {view.live.message}</div>}

      <section className="tv-now">
        <div className="tv-label">{view.now ? "Now performing" : "The stage is open"}</div>
        {view.now ? (
          <>
            <div className="tv-now-name">{view.now.name}</div>
            <div className="tv-now-detail">
              <EntryDetail e={view.now} />
            </div>
          </>
        ) : (
          <div className="tv-now-empty">
            {view.queue.length ? `Up first: ${view.queue[0].name}` : karaoke ? "Scan to pick a song" : "Scan to sign up"}
          </div>
        )}
      </section>

      <section className="tv-next">
        <div className="tv-label">Up next</div>
        {next.length === 0 ? (
          <p className="tv-next-empty">Nobody in line yet.</p>
        ) : (
          <ol className="tv-next-list">
            {next.map((e, i) => (
              <li key={e.id}>
                <span className="tv-next-pos">{i + 1}</span>
                <span className="tv-next-main">
                  <span className="tv-next-name">{e.name}</span>
                  {karaoke && e.song && <span className="tv-next-song">{e.song}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
        {more > 0 && <p className="tv-more">and {more} more</p>}
      </section>

      <aside className="tv-join">
        <QrCode text={join.url} size={220} className="tv-qr" />
        <div className="tv-join-text">
          <div className="tv-join-call">{view.live.signupsOpen ? "Sign up on your phone" : "Signups paused"}</div>
          <JoinAddress url={join.short} minScale={0.8} lines={2} align="start" className="tv-join-url" />
          <div className="tv-code">
            <strong>{view.queue.length}</strong> waiting
          </div>
        </div>
      </aside>
    </div>
  );
}
