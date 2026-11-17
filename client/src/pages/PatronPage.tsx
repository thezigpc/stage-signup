import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BackToGames, useSharedScreen } from "@bargames/gamekit/client";
import type { PublicStage } from "@signup/shared";
import { api } from "../api";
import { deviceId, newDeviceId } from "../session";
import { useGameName } from "../useGameName";
import { useStage } from "../useStage";
import { useToast } from "../useToast";
import { useVenue } from "../useVenue";
import { PatronView } from "./PatronView";

/**
 * The page patrons land on (the venue page, a table QR code). No code to type. With one stage
 * there's no picker; with several, ?stage= (a stage's own QR) goes straight to it.
 */
export function PatronPage() {
  const gameName = useGameName();
  const venue = useVenue();
  const [search, setSearch] = useSearchParams();
  const [stages, setStages] = useState<PublicStage[] | null>(null);
  const [error, setError] = useState("");
  const asked = search.get("stage") ?? "";

  useEffect(() => {
    api<{ stages: PublicStage[] }>("/api/stages")
      .then((r) => setStages(r.stages))
      .catch((e: Error) => setError(e.message));
  }, []);

  const chosen = useMemo(() => {
    if (!stages) return undefined;
    if (stages.length === 1) return stages[0].id;
    return stages.find((s) => s.id === asked)?.id;
  }, [stages, asked]);

  const pick = (id: string | null) => {
    const next = new URLSearchParams(search);
    if (id) next.set("stage", id);
    else next.delete("stage");
    setSearch(next, { replace: !id });
  };

  return (
    <div className="page-patron">
      <header className="app-header">
        <span className="app-title">{gameName}</span>
        {stages && stages.length > 1 && chosen && (
          <button className="btn btn-small btn-ghost" onClick={() => pick(null)}>
            Other stages
          </button>
        )}
      </header>
      {error && <p className="error page-pad">{error}</p>}
      {!stages && !error && <p className="muted page-pad">Loading…</p>}
      {stages && stages.length === 0 && (
        <main className="patron">
          <section className="panel">
            <h2>No signups tonight</h2>
            <p className="muted">There's no list open right now. Check back later.</p>
          </section>
        </main>
      )}
      {stages && stages.length > 1 && !chosen && (
        <main className="patron">
          <section className="panel">
            <h2>Pick a stage</h2>
            <div className="stage-picks">
              {stages.map((s) => (
                <button key={s.id} className="btn btn-secondary btn-big" onClick={() => pick(s.id)}>
                  {s.mode === "karaoke" ? "🎤" : "🎸"} {s.name}
                </button>
              ))}
            </div>
          </section>
        </main>
      )}
      {chosen && <StageSignup stage={chosen} onGone={() => pick(null)} />}
      <footer className="home-foot">
        <Link to="/admin" className="muted small">
          Admin
        </Link>
      </footer>
      {/* Bar Games: back to the venue's games list. Nothing off a box. */}
      <BackToGames ctx={venue} />
    </div>
  );
}

function StageSignup({ stage, onGone }: { stage: string; onGone: () => void }) {
  // A shared screen (kit 0.10.2: a box touchscreen, or a venue app in kiosk mode) is a signup
  // kiosk, not someone's phone: each patron gets a fresh, unsaved device id, and "Next person"
  // starts over with another one.
  const kiosk = useSharedScreen();
  const [device, setDevice] = useState(() => (kiosk ? newDeviceId() : deviceId()));
  const { view, status, gone, skew } = useStage(stage, "patron", device);
  const { toast, setToast } = useToast();
  if (gone) {
    return (
      <main className="patron">
        <section className="panel">
          <h2>Not taking signups</h2>
          <p>{gone}</p>
          <button className="btn btn-primary" onClick={onGone}>
            See the stages
          </button>
        </section>
      </main>
    );
  }
  if (!view) return <p className="muted page-pad">Connecting…</p>;
  return (
    <>
      {status !== "online" && (
        <div className="banner" role="status">
          Connection lost. Reconnecting…
        </div>
      )}
      <PatronView
        view={view}
        skew={skew}
        onError={setToast}
        kiosk={kiosk ? { next: () => setDevice(newDeviceId()) } : undefined}
      />
      {toast && (
        <div className="toast" role="alert" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </>
  );
}
