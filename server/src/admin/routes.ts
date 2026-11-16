import { adminRouter as kitAdminRouter, createAdminAuth, log } from "@bargames/gamekit/server";
import type express from "express";
import type { AdminStages } from "@signup/shared";
import { ADMIN_PASSWORD, store } from "../config.js";
import { bg, clientIp, onBox } from "../bargames.js";
import { GameError } from "../errors.js";
import type { Stages } from "../stages/registry.js";

/**
 * The admin password (the kit's admin auth): ADMIN_PASSWORD, or a scrypt hash chosen once on
 * the /admin setup screen (DATA_DIR/admin.json). On a box the venue's admin password works
 * too, and only staff the box vouches for may set a separate one. Guests never get in here.
 */
export const adminAuth = createAdminAuth({
  store,
  envPassword: ADMIN_PASSWORD,
  saltFormat: "bytes",
  // Standalone behind a proxy a venue's Wi-Fi shares one IP: no per-IP lockout (the kit's
  // global cap and capped delay still slow guessing). On a box each device has its own address.
  failsAllowed: onBox ? undefined : Infinity,
  venuePassword: (password, ip) => bg.checkVenuePassword(password, ip),
  onBox: bg.connected,
});

/** /api/admin/*: the kit's status, setup, login and logout, then the stages' setup (staff only). */
export function adminRouter(stages: Stages): express.Router {
  const r = kitAdminRouter({ auth: adminAuth, clientIp, trusted: (req) => bg.isStaff(req) });

  const send = (res: express.Response) => {
    const body: AdminStages = { stages: stages.all().map((s) => s.config) };
    res.json({ ok: true, ...body });
  };
  const fail = (res: express.Response, err: unknown) => {
    if (err instanceof GameError) return void res.status(400).json({ ok: false, error: err.message });
    log.error("admin", "stages", { err: String(err) });
    res.status(500).json({ ok: false, error: "Couldn't save." });
  };

  r.get("/stages", (_req, res) => send(res));

  r.post("/stages", async (req, res) => {
    try {
      await stages.create(req.body);
      send(res);
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/stages/:id", async (req, res) => {
    try {
      await stages.update(String(req.params.id), req.body);
      send(res);
    } catch (err) {
      fail(res, err);
    }
  });

  r.delete("/stages/:id", async (req, res) => {
    try {
      await stages.remove(String(req.params.id));
      send(res);
    } catch (err) {
      fail(res, err);
    }
  });

  r.put("/stage-order", async (req, res) => {
    try {
      await stages.reorder(req.body?.ids);
      send(res);
    } catch (err) {
      fail(res, err);
    }
  });

  return r;
}
