import path from "path";
import { createJsonStore } from "@bargames/gamekit/server";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3011);
/** Built client, served by this process in production (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Persisted admin state (password hash, settings). On a box: /data. */
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(here, "../../data");
export const store = createJsonStore(DATA_DIR);
/** Default for the admin "close rooms after N minutes idle" setting. A night runs long. */
export const DEFAULT_ROOM_IDLE_MINUTES = num("ROOM_IDLE_MINUTES", 360);
export const ROOM_SWEEP_INTERVAL_MS = num("ROOM_SWEEP_INTERVAL_MS", 60 * 1000);
/** Overrides the admin password set through the /admin setup screen. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
export const MAX_ROOMS = num("MAX_ROOMS", 100);
export const MAX_PATRONS_PER_ROOM = num("MAX_PATRONS_PER_ROOM", 500);
export const MAX_TABLES_PER_ROOM = num("MAX_TABLES_PER_ROOM", 8);
export const MAX_COHOSTS_PER_ROOM = num("MAX_COHOSTS_PER_ROOM", 10);
/** Signups one IP may make per minute (all phones behind it together). */
export const SIGNUPS_PER_MINUTE_PER_IP = num("SIGNUPS_PER_MINUTE_PER_IP", 60);
