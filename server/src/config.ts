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
/** Admin password hash, the stages and tonight's lists. On a box: /data. */
export const DATA_DIR = process.env.DATA_DIR ?? path.resolve(here, "../../data");
export const store = createJsonStore(DATA_DIR);
/** Overrides the admin password set through the /admin setup screen. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Signups one IP may make per minute (all phones behind it together). */
export const SIGNUPS_PER_MINUTE_PER_IP = num("SIGNUPS_PER_MINUTE_PER_IP", 60);
/** How long after the last change tonight's lists are written to disk. */
export const SAVE_DELAY_MS = num("SAVE_DELAY_MS", 500);
