import { createServer } from "http";
import { existsSync } from "fs";
import express from "express";
import { Server } from "socket.io";
import { DEFAULT_GAME_NAME } from "@signup/shared";
import { log, serveSpa, SOCKET_SERVER_OPTIONS } from "@bargames/gamekit/server";
import { CLIENT_DIST_PATH, PORT, SAVE_DELAY_MS, store } from "./config.js";
import { adminAuth, adminRouter } from "./admin/routes.js";
import { runRouter } from "./run/routes.js";
import { registerSocketHandlers, type IO } from "./socket/index.js";
import { bg, displayName, emitStageEvent, noteWaiting } from "./bargames.js";
import { Stages } from "./stages/registry.js";

await adminAuth.init();
const stages = new Stages(store, SAVE_DELAY_MS);
await stages.init();

const app = express();
const httpServer = createServer(app);
const io: IO = new Server(httpServer, {
  // Half-open phones noticed in ~15 s (10 s ping, 5 s timeout).
  ...SOCKET_SERVER_OPTIONS,
  maxHttpBufferSize: 64 * 1024,
});

const live = registerSocketHandlers(io, stages);
stages.onChange = (id, gone) => {
  live.broadcast(id, gone);
  const s = stages.get(id);
  if (s) noteWaiting(s);
};
stages.onEvent = (stage, e) => emitStageEvent(stage, e);

// Bar Games: /__bargames/* (venue.json, theme.css, status). Before the SPA catch-all.
// A no-op standalone.
app.use(bg.middleware());

app.get("/health", (_req, res) => {
  res.json({ ok: true, stages: stages.all().length });
});
app.get("/api/config", async (_req, res) => {
  res.json({ gameName: await displayName(process.env.GAME_NAME || DEFAULT_GAME_NAME) });
});
app.get("/api/stages", (_req, res) => {
  res.json({ ok: true, stages: stages.publicList() });
});
app.use("/api/admin", adminRouter(stages));
app.use("/api/run", runRouter({ auth: adminAuth, stages, lease: live.lease }));

if (existsSync(CLIENT_DIST_PATH)) {
  // The built client; under a path prefix (BG_BASE_PATH / BASE_PATH) the page gets its <base href>.
  serveSpa(app, { dist: CLIENT_DIST_PATH });
} else {
  log.warn("boot", "client build not found; serving API only", { path: CLIENT_DIST_PATH });
}

httpServer.listen(PORT, () => {
  log.info("boot", "listening", { port: PORT, onBox: bg.connected, stages: stages.all().length });
});

// Deploys and updates: save tonight's lists, flush box events, then exit. The lists come back
// on start, so a restart doesn't lose the queue.
let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log.info("boot", "shutting down", { signal });
  const hardStop = setTimeout(() => process.exit(0), 3000);
  hardStop.unref();
  await stages.flush().catch(() => {});
  await bg.flush().catch(() => {});
  io.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
