import { adminRouter as kitAdminRouter, createAdminAuth, log } from "@bargames/gamekit/server";
import type express from "express";
import type { AdminOverview, AdminSettings } from "@signup/shared";
import { ADMIN_PASSWORD, store } from "../config.js";
import { ADMIN_CLOSE_REASON, listRooms, type Rooms } from "../rooms/registry.js";
import { bg, clientIp, onBox } from "../bargames.js";
import { getAdminSettings, updateAdminSettings } from "./settings.js";

/**
 * The admin password (the kit's admin auth): ADMIN_PASSWORD, or a scrypt hash chosen once on
 * the /admin setup screen (DATA_DIR/admin.json). On a box the venue's admin password works
 * too, and only staff the box vouches for may set a separate one.
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

/** /api/admin/*: the kit's status, setup, login and logout, then the room list, close and settings. */
export function adminRouter(rooms: Rooms): express.Router {
  const r = kitAdminRouter({ auth: adminAuth, clientIp, trusted: (req) => bg.isStaff(req) });

  r.get("/overview", (_req, res) => {
    const body: AdminOverview = { rooms: listRooms(rooms), settings: getAdminSettings(), serverTime: Date.now() };
    res.json(body);
  });

  r.post("/rooms/:code/close", (req, res) => {
    const code = String(req.params.code).toUpperCase();
    const ok = rooms.closeRoom(code, ADMIN_CLOSE_REASON, "admin");
    log.info("admin", "closed room", { code, ok });
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { ok: false, error: "That room is already gone." });
  });

  r.put("/settings", async (req, res) => {
    try {
      const settings = await updateAdminSettings((req.body ?? {}) as Partial<AdminSettings>);
      log.info("admin", "settings updated", { roomIdleMinutes: settings.roomIdleMinutes });
      rooms.sweepIdle();
      res.json({ ok: true, settings });
    } catch (err) {
      res.status(400).json({ ok: false, error: err instanceof Error ? err.message : "Couldn't save." });
    }
  });

  return r;
}
