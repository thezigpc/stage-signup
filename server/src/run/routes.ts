// /api/run: running the list. Staff (the app's admin session, or box staff) or a guest host
// or co-host from the box's guest link (the kit's staffOrGuest, checked on EVERY request,
// because guest links end at closing time or when staff turn them off). The stages' setup
// stays on /api/admin, staff only.

import express, { type Request, type Response } from "express";
import { log, staffOrGuest, type AdminAuth } from "@bargames/gamekit/server";
import type { GuestInfo } from "@bargames/sdk";
import { LIMITS, cleanText, type CohostLink, type EntryInput, type RunnerInfo } from "@signup/shared";
import { bg, guestOf, isBoxStaff } from "../bargames.js";
import { GameError } from "../errors.js";
import type { Stage } from "../stages/Stage.js";
import type { Stages } from "../stages/registry.js";

export interface RunDeps {
  auth: AdminAuth;
  stages: Stages;
  /** This socket may see the runner's view of `stage` for a while (renewed by the page). */
  lease: (socketId: string, stage: Stage) => boolean;
}

const entryInput = (b: Record<string, unknown>): EntryInput => ({
  name: typeof b.name === "string" ? b.name : undefined,
  song: typeof b.song === "string" ? b.song : undefined,
  artist: typeof b.artist === "string" ? b.artist : undefined,
  note: typeof b.note === "string" ? b.note : undefined,
  with: typeof b.with === "string" ? b.with : undefined,
});

/** The list actions, by URL name. Each runs one Stage method. */
const ACTIONS: Record<string, (s: Stage, b: Record<string, unknown>) => object | void> = {
  next: (s) => s.nextPerformer(),
  done: (s) => s.finishCurrent(),
  "now-on": (s, b) => s.nowOn(b.entryId),
  skip: (s, b) => s.skip(b.entryId),
  "to-end": (s, b) => s.moveToEnd(b.entryId),
  restore: (s, b) => s.restore(b.entryId),
  move: (s, b) => s.moveEntry(b.entryId, b.toIndex),
  add: (s, b) => ({ entryId: s.addEntry(entryInput(b)).id }),
  edit: (s, b) => s.editEntry(b.entryId, entryInput(b)),
  signups: (s, b) => s.setSignupsOpen(b.open === true),
  message: (s, b) => s.setMessage(b.message),
  "new-night": (s) => s.newNight(),
};

const guestHere = (res: Response): GuestInfo | undefined => res.locals.guest as GuestInfo | undefined;

export function runRouter({ auth, stages, lease }: RunDeps): express.Router {
  const r = express.Router();
  r.use(express.json({ limit: "16kb" }));
  r.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  r.use(staffOrGuest({ auth, guest: (req) => guestOf(req), trusted: (req) => isBoxStaff(req) }));

  r.get("/me", (_req, res) => {
    const g = guestHere(res);
    const body: RunnerInfo = g
      ? { kind: "guest", guest: { id: g.id, role: g.role, name: g.name }, canAddCohosts: g.role === "host" }
      : { kind: "staff", canAddCohosts: false };
    res.json({ ok: true, ...body, stages: stages.all().map((s) => ({ id: s.config.id, name: s.config.name, enabled: s.config.enabled })) });
  });

  // The page proves it may still run the list, and its socket gets the runner's view.
  r.post("/lease", (req, res) => {
    const stage = stages.get(req.body?.stage);
    const socketId = typeof req.body?.socketId === "string" ? req.body.socketId : "";
    if (!stage || !socketId || !lease(socketId, stage)) return void res.status(400).json({ ok: false, error: "Reconnect and try again." });
    res.json({ ok: true });
  });

  r.post("/:stage/:action", (req: Request, res: Response) => {
    const stage = stages.get(req.params.stage);
    const fn = ACTIONS[req.params.action];
    if (!stage || !fn) return void res.status(404).json({ ok: false, error: "No such stage or action." });
    try {
      const result = fn(stage, (req.body ?? {}) as Record<string, unknown>) ?? {};
      stages.changed(stage);
      const g = guestHere(res);
      if (req.params.action === "new-night" || req.params.action === "signups") {
        log.info("run", req.params.action, { stage: stage.config.id, by: g ? `guest:${g.role}` : "staff" });
      }
      res.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof GameError) return void res.status(400).json({ ok: false, error: err.message });
      log.error("run", "action threw", { action: req.params.action, err: String(err) });
      res.status(500).json({ ok: false, error: "Something went wrong." });
    }
  });

  // ----------------------------------------------- a guest host's co-hosts

  const requireGuestHost = (res: Response): GuestInfo | undefined => {
    const g = guestHere(res);
    if (g?.role === "host") return g;
    res.status(403).json({ ok: false, error: "Only a guest host adds and removes co-hosts." });
    return undefined;
  };
  const mine = async (g: GuestInfo): Promise<CohostLink[]> =>
    (await bg.guests.list())
      .filter((l) => l.role === "cohost" && l.parentId === g.id)
      .map((l) => ({ id: l.id, label: l.label, expiresAt: l.expiresAt }));

  r.get("/cohosts", async (_req, res) => {
    const g = requireGuestHost(res);
    if (!g) return;
    res.json({ ok: true, cohosts: await mine(g).catch(() => []) });
  });

  r.post("/cohosts", async (req, res) => {
    const g = requireGuestHost(res);
    if (!g) return;
    const label = cleanText(req.body?.name, LIMITS.cohostName) || "Co-host";
    try {
      const made = await bg.guests.addCohost(req, label);
      log.info("run", "co-host added", { by: g.id });
      res.json({ ok: true, id: made.id, url: made.url, expiresAt: made.expiresAt, label: made.label });
    } catch (err) {
      // The box's own words (e.g. the venue hasn't allowed co-hosts for this app), as-is.
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "The box refused." });
    }
  });

  r.delete("/cohosts/:id", async (req, res) => {
    const g = requireGuestHost(res);
    if (!g) return;
    try {
      if (!(await mine(g)).some((c) => c.id === req.params.id)) return void res.status(404).json({ ok: false, error: "That isn't one of your co-hosts." });
      await bg.guests.revoke(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "The box refused." });
    }
  });

  return r;
}
