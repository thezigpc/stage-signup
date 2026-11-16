// Sockets carry the live view of one stage, and the patron's own signups.
//
// - Every socket "watch"es one stage as a patron, a TV, or a runner. Patrons send their
//   device id (localStorage), which is who they are: no seats, no tokens.
// - A runner's socket only gets the runner's view (notes, history) while it holds a lease,
//   which the page renews over HTTP through /api/run (staffOrGuest). So a guest link that
//   ends stops the private view within a lease, even on an open socket.
// - Running the list is HTTP only (/api/run): every action is checked as it happens.

import type { Server, Socket } from "socket.io";
import {
  ERRORS,
  type ClientToServerEvents,
  type EntryInput,
  type ServerToClientEvents,
  type ViewerRole,
} from "@signup/shared";
import { log } from "@bargames/gamekit/server";
import { clientIp } from "../bargames.js";
import { SIGNUPS_PER_MINUTE_PER_IP } from "../config.js";
import { GameError } from "../errors.js";
import { DEVICE_RE, type Stage } from "../stages/Stage.js";
import type { Stages } from "../stages/registry.js";

interface SocketData {
  stage?: string;
  role?: ViewerRole;
  device?: string;
  /** The runner's view until (ms). */
  runnerUntil?: number;
  lastEvent?: string;
}
export type IO = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type S = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type AckFn = (res: { ok: boolean; [k: string]: unknown }) => void;

/** How long a runner's view lasts without a renewal (the page renews every 60 s). */
export const LEASE_MS = Number(process.env.RUNNER_LEASE_MS) > 0 ? Number(process.env.RUNNER_LEASE_MS) : 150_000;

// Signups per IP: a phone can't flood the list by clearing its storage over and over.
// Generous: standalone behind Cloudflare a whole bar's Wi-Fi shares one public IP.
const SIGNUP_WINDOW_MS = 60_000;
const signups = new Map<string, number[]>();
function signupLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (signups.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  signups.set(ip, recent);
  if (recent.length >= SIGNUPS_PER_MINUTE_PER_IP) return true;
  recent.push(now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of signups) if (list.every((t) => now - t >= SIGNUP_WINDOW_MS)) signups.delete(ip);
}, SIGNUP_WINDOW_MS).unref();

const entryInput = (req: unknown): EntryInput => {
  const r = (req ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  return { name: str(r.name), song: str(r.song), artist: str(r.artist), note: str(r.note), with: str(r.with) };
};

const roomOf = (stageId: string) => `stage:${stageId}`;

export interface Live {
  /** Sends a stage's views to everyone watching it. `gone`: it was turned off or removed. */
  broadcast(stageId: string, gone?: boolean): void;
  lease(socketId: string, stage: Stage): boolean;
}

export function registerSocketHandlers(io: IO, stages: Stages): Live {
  const effectiveRole = (s: S): ViewerRole => {
    const role = s.data.role ?? "tv";
    if (role !== "runner") return role;
    return (s.data.runnerUntil ?? 0) > Date.now() ? "runner" : "tv";
  };

  const sendView = (s: S, stage: Stage) => s.emit("state", stage.viewFor(effectiveRole(s), s.data.device));

  const broadcast = (stageId: string, gone = false) => {
    const stage = stages.get(stageId);
    for (const id of io.sockets.adapter.rooms.get(roomOf(stageId)) ?? []) {
      const s = io.sockets.sockets.get(id) as S | undefined;
      if (!s) continue;
      // A stage turned off: patrons and TVs are told; runners keep it (staff can turn it back on).
      if (!stage || (gone && s.data.role !== "runner")) {
        s.emit("gone", { reason: stage ? "This stage isn't taking signups tonight." : "This stage was removed." });
        void s.leave(roomOf(stageId));
        s.data.stage = undefined;
        continue;
      }
      sendView(s, stage);
    }
  };

  const lease = (socketId: string, stage: Stage): boolean => {
    const s = io.sockets.sockets.get(socketId) as S | undefined;
    if (!s || s.data.role !== "runner" || s.data.stage !== stage.config.id) return false;
    const had = effectiveRole(s) === "runner";
    s.data.runnerUntil = Date.now() + LEASE_MS;
    if (!had) sendView(s, stage);
    return true;
  };

  // Leases that ran out: back to the public view (no notes, no history).
  setInterval(() => {
    const now = Date.now();
    for (const s of io.sockets.sockets.values() as IterableIterator<S>) {
      if (s.data.role === "runner" && s.data.runnerUntil && s.data.runnerUntil <= now) {
        s.data.runnerUntil = undefined;
        const stage = stages.get(s.data.stage);
        if (stage) sendView(s, stage);
      }
    }
  }, Math.min(10_000, Math.max(100, LEASE_MS / 3))).unref();

  io.on("connection", (socket: S) => {
    const ip = clientIp(socket.request);
    socket.onAny((event: string) => {
      socket.data.lastEvent = event;
    });

    const fail = (ack: AckFn | undefined, err: unknown) => {
      if (!(err instanceof GameError)) log.error("socket", "handler threw", { event: socket.data.lastEvent, err: String(err) });
      if (typeof ack === "function") ack({ ok: false, error: err instanceof GameError ? err.message : ERRORS.BAD_REQUEST });
    };

    const watched = (): Stage => {
      const stage = stages.get(socket.data.stage);
      if (!stage) throw new GameError("NO_STAGE");
      return stage;
    };

    socket.on("watch", (req, ack) => {
      try {
        const role: ViewerRole = req?.role === "runner" || req?.role === "patron" ? req.role : "tv";
        // Runners may watch a stage that's off (to turn it back on from /admin and run it).
        // A TV whose ?stage= is gone (renamed, removed, off) shows the first stage that's on
        // rather than nothing: the box may cast it, or use it as an idle screen.
        const stage =
          role === "runner"
            ? (stages.get(req?.stage) ?? stages.resolve(undefined))
            : role === "tv"
              ? (stages.resolve(req?.stage) ?? stages.resolve(undefined))
              : stages.resolve(req?.stage);
        if (!stage) throw new GameError("NO_STAGE");
        if (socket.data.stage && socket.data.stage !== stage.config.id) void socket.leave(roomOf(socket.data.stage));
        if (socket.data.role !== role) socket.data.runnerUntil = undefined;
        socket.data.stage = stage.config.id;
        socket.data.role = role;
        socket.data.device = role === "patron" && typeof req?.device === "string" && DEVICE_RE.test(req.device) ? req.device : undefined;
        void socket.join(roomOf(stage.config.id));
        ack({ ok: true, stage: stage.config.id });
        sendView(socket, stage);
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("signUp", (req, ack) => {
      try {
        const stage = watched();
        if (socket.data.role !== "patron" || !socket.data.device) throw new GameError("NO_DEVICE");
        if (signupLimited(ip)) throw new GameError("RATE_LIMITED");
        const entry = stage.signUp(socket.data.device, entryInput(req));
        ack({ ok: true, entryId: entry.id });
        stages.changed(stage);
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("dropOut", (entryId, ack) => {
      try {
        const stage = watched();
        if (socket.data.role !== "patron" || !socket.data.device) throw new GameError("NO_DEVICE");
        stage.dropOut(socket.data.device, entryId);
        ack({ ok: true });
        stages.changed(stage);
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });
  });

  return { broadcast, lease };
}
