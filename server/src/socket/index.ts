import type { Server, Socket } from "socket.io";
import {
  ERRORS,
  LIMITS,
  cleanText,
  type ClientToServerEvents,
  type EntryInput,
  type JoinResult,
  type Mode,
  type RoomSettings,
  type ServerToClientEvents,
} from "@signup/shared";
import { log } from "@bargames/gamekit/server";
import { clientIp, HOST_CLOSE_REASON } from "../bargames.js";
import { SIGNUPS_PER_MINUTE_PER_IP } from "../config.js";
import { GameError } from "../rooms/errors.js";
import { cohostPath, type Member, type Room } from "../rooms/Room.js";
import type { Rooms } from "../rooms/registry.js";

interface SocketData {
  code?: string;
  memberId?: string;
  lastEvent?: string;
}
export type IO = Server<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type S = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;
type AckFn = (res: { ok: boolean; [k: string]: unknown }) => void;

// Failed joins per IP: the room code is the only gate on the join URL, so guessing codes
// must not be free.
const JOIN_WINDOW_MS = 60_000;
const JOIN_FAILS_ALLOWED = 20;
const joinFails = new Map<string, number[]>();

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (joinFails.get(ip) ?? []).filter((t) => now - t < JOIN_WINDOW_MS);
  joinFails.set(ip, recent);
  return recent.length >= JOIN_FAILS_ALLOWED;
}
function noteJoinFail(ip: string): void {
  const list = joinFails.get(ip) ?? [];
  list.push(Date.now());
  joinFails.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of joinFails) if (list.every((t) => now - t >= JOIN_WINDOW_MS)) joinFails.delete(ip);
}, JOIN_WINDOW_MS).unref();

// Signups per IP: a phone can't flood the list by clearing its storage over and over.
// Generous: standalone behind Cloudflare a whole bar's Wi-Fi shares one public IP, and the
// first song of the night brings a rush. (On a box each device has its own address.)
const SIGNUP_WINDOW_MS = 60_000;
const SIGNUPS_ALLOWED = SIGNUPS_PER_MINUTE_PER_IP;
const signups = new Map<string, number[]>();
function signupLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (signups.get(ip) ?? []).filter((t) => now - t < SIGNUP_WINDOW_MS);
  signups.set(ip, recent);
  if (recent.length >= SIGNUPS_ALLOWED) return true;
  recent.push(now);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of signups) if (list.every((t) => now - t >= SIGNUP_WINDOW_MS)) signups.delete(ip);
}, SIGNUP_WINDOW_MS).unref();

const entryInput = (req: unknown): EntryInput => {
  const r = (req ?? {}) as Record<string, unknown>;
  return {
    name: typeof r.name === "string" ? r.name : undefined,
    song: typeof r.song === "string" ? r.song : undefined,
    artist: typeof r.artist === "string" ? r.artist : undefined,
    note: typeof r.note === "string" ? r.note : undefined,
    with: typeof r.with === "string" ? r.with : undefined,
  };
};

export function registerSocketHandlers(io: IO, rooms: Rooms): void {
  io.on("connection", (socket: S) => {
    const ip = clientIp(socket.request);
    socket.onAny((event: string) => {
      socket.data.lastEvent = event;
    });

    const fail = (ack: AckFn | undefined, err: unknown) => {
      if (!(err instanceof GameError)) {
        log.error("socket", "handler threw", { event: socket.data.lastEvent, err: String(err) });
      }
      log.warn("socket", "rejected", {
        event: socket.data.lastEvent,
        code: socket.data.code,
        member: socket.data.memberId,
        error: err instanceof GameError ? err.code : "INTERNAL",
      });
      if (typeof ack === "function") ack({ ok: false, error: err instanceof GameError ? err.message : ERRORS.BAD_REQUEST });
    };

    const unbind = () => {
      const { code, memberId } = socket.data;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (code && memberId) {
        const room = rooms.get(code);
        if (room) {
          room.detachSocket(memberId, socket.id);
          room.broadcast();
        }
      }
    };

    const bind = (room: Room, member: Member): JoinResult => {
      if (socket.data.code !== room.code || socket.data.memberId !== member.id) unbind();
      room.attachSocket(member, socket.id);
      // Any attach to the host seat closes the box's "first joiner hosts" offer.
      room.noteAttached(member);
      socket.data.code = room.code;
      socket.data.memberId = member.id;
      return { code: room.code, token: member.token, memberId: member.id, role: member.role, name: member.name };
    };

    const findRoom = (code: unknown): Room => {
      if (rateLimited(ip)) throw new GameError("RATE_LIMITED");
      const room = rooms.get(String(code ?? ""));
      if (!room) {
        noteJoinFail(ip);
        throw new GameError("ROOM_NOT_FOUND");
      }
      return room;
    };

    /** Runs a room-scoped intent, then broadcasts the new state to everyone. */
    function on<A>(event: keyof ClientToServerEvents, fn: (room: Room, memberId: string, arg: A) => object | void) {
      (socket.on as (e: string, h: (...args: unknown[]) => void) => void)(event, (...args: unknown[]) => {
        const ack = args[args.length - 1] as AckFn;
        const arg = (args.length > 1 ? args[0] : undefined) as A;
        try {
          const { code, memberId } = socket.data;
          const room = code ? rooms.get(code) : undefined;
          if (!room || !memberId || !room.members.has(memberId)) throw new GameError("NOT_IN_ROOM");
          const result = fn(room, memberId, arg) ?? {};
          room.broadcast();
          if (typeof ack === "function") ack({ ok: true, ...result });
        } catch (err) {
          fail(ack, err);
        }
      });
    }

    socket.on("createRoom", (req, ack) => {
      try {
        const mode: Mode = req?.mode === "openmic" ? "openmic" : "karaoke";
        const room = rooms.create("patron", (r) => {
          r.title = cleanText(req?.title, LIMITS.title) || undefined;
          r.updateSettings({ mode });
          r.addHost(String(req?.name ?? ""));
        });
        const host = room.members.get(room.hostId)!;
        const result = bind(room, host);
        log.info("room", "created", { code: room.code, mode });
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("roomInfo", (req, ack) => {
      try {
        const room = findRoom(req?.code);
        ack({ ok: true, mode: room.settings.mode, title: room.title });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("joinRoom", (req, ack) => {
      try {
        const room = findRoom(req?.code);
        if (req.role !== "patron" && req.role !== "table") throw new GameError("BAD_REQUEST");
        // A known token means "same seat again", never a second seat.
        const existing = room.seatFor(req.token);
        let member: Member;
        if (req.cohost !== undefined) {
          // A co-host invite (the host's or the box's "Add a co-host" QR): single use.
          if (req.role !== "patron" || !room.seats.redeem(req.cohost)) throw new GameError("BAD_INVITE");
          member = room.seatCohost(existing ?? room.patronByDevice(req.device), req.name);
        } else if (existing && (existing.role === req.role || req.role === "patron")) {
          member = existing;
        } else if (req.role === "table") {
          member = room.addTable();
        } else if (room.seats.offerOpen) {
          // A box room with nobody hosting yet: the first phone in takes the host seat.
          member = room.claimHostSeat(req.name);
        } else {
          member = room.addPatron(req.device);
        }
        const result = bind(room, member);
        log.info("room", existing ? "rejoined" : "joined", { code: room.code, role: member.role });
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // Sent by the client on EVERY socket connect: socket.io reconnects with a brand-new
    // server-side socket that has no room binding.
    socket.on("resume", (req, ack) => {
      try {
        const room = findRoom(req?.code);
        const member = room.seatFor(req?.token);
        if (!member) {
          noteJoinFail(ip);
          throw new GameError("BAD_TOKEN");
        }
        const result = bind(room, member);
        ack({ ok: true, ...result });
        room.broadcast();
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    socket.on("leaveRoom", (ack) => {
      const { code, memberId } = socket.data;
      const room = code ? rooms.get(code) : undefined;
      socket.data.code = undefined;
      socket.data.memberId = undefined;
      if (room && memberId) {
        room.detachSocket(memberId, socket.id);
        // A patron leaving keeps their place in line (their signup isn't their phone);
        // they drop out with "Drop out". Co-hosts and TVs leave for good.
        const m = room.members.get(memberId);
        if (m && m.role !== "patron" && m.role !== "host") room.removeMember(memberId, "You left.");
        room.broadcast();
      }
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("closeRoom", (ack) => {
      try {
        const { code, memberId } = socket.data;
        const room = code ? rooms.get(code) : undefined;
        if (!room || !memberId) throw new GameError("NOT_IN_ROOM");
        room.requireHost(memberId);
        rooms.closeRoom(room.code, HOST_CLOSE_REASON, "host");
        ack({ ok: true });
      } catch (err) {
        fail(ack as AckFn, err);
      }
    });

    // ---------------------------------------------------------- patrons
    on<EntryInput>("signUp", (room, id, req) => {
      if (signupLimited(ip)) throw new GameError("RATE_LIMITED");
      return { entryId: room.signUp(id, entryInput(req)).id };
    });
    on<string>("dropOut", (room, id, entryId) => room.dropOut(id, String(entryId)));

    // --------------------------------------------------- host and co-hosts
    on<EntryInput>("addEntry", (room, id, req) => {
      room.requireRunner(id);
      return { entryId: room.addEntry(entryInput(req)).id };
    });
    on<{ entryId: string } & EntryInput>("editEntry", (room, id, req) => {
      room.requireRunner(id);
      room.editEntry(String(req?.entryId ?? ""), entryInput(req));
    });
    on<{ entryId: string; toIndex: number }>("moveEntry", (room, id, req) => {
      room.requireRunner(id);
      room.moveEntry(String(req?.entryId ?? ""), Number(req?.toIndex));
    });
    on<string>("moveToEnd", (room, id, entryId) => {
      room.requireRunner(id);
      room.moveToEnd(String(entryId));
    });
    on<string>("skipEntry", (room, id, entryId) => {
      room.requireRunner(id);
      room.skip(String(entryId));
    });
    on<string>("nowOn", (room, id, entryId) => {
      room.requireRunner(id);
      room.nowOn(String(entryId));
    });
    on<string>("restoreEntry", (room, id, entryId) => {
      room.requireRunner(id);
      room.restore(String(entryId));
    });
    on("nextPerformer", (room, id) => {
      room.requireRunner(id);
      room.nextPerformer();
    });
    on("finishCurrent", (room, id) => {
      room.requireRunner(id);
      room.finishCurrent();
    });
    on<boolean>("setSignupsOpen", (room, id, open) => {
      room.requireRunner(id);
      room.setSignupsOpen(Boolean(open));
    });
    on<string>("setMessage", (room, id, message) => {
      room.requireRunner(id);
      room.setMessage(message);
    });
    on<Partial<RoomSettings>>("updateSettings", (room, id, patch) => {
      room.requireRunner(id);
      room.updateSettings(patch && typeof patch === "object" ? patch : {});
    });

    // ---------------------------------------------------------- host only
    on("cohostInvite", (room, id) => {
      room.requireHost(id);
      const inv = room.seats.invite();
      log.info("room", "co-host invite", { code: room.code, expiresAt: inv.expiresAt });
      return { path: cohostPath(room, inv.token), expiresAt: inv.expiresAt };
    });
    on<string>("removeCohost", (room, id, target) => {
      room.requireHost(id);
      if (!room.seats.isCohost(String(target))) throw new GameError("BAD_REQUEST");
      room.demoteCohost(String(target));
    });

    socket.on("disconnect", () => unbind());
  });
}
