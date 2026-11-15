import {
  DEFAULT_SETTINGS,
  LIMITS,
  cleanText,
  type AdminRoomSummary,
  type EntryInput,
  type EntryStatus,
  type EntryView,
  type Role,
  type RoomSettings,
  type RoomView,
  type SignupGate,
} from "@signup/shared";
import {
  HostSeats,
  log,
  newId,
  newToken,
  type CloseCause,
  type KitRoom,
  type RoomOverview,
  type SessionKind,
} from "@bargames/gamekit/server";
import { bg } from "../bargames.js";
import { MAX_COHOSTS_PER_ROOM, MAX_PATRONS_PER_ROOM, MAX_TABLES_PER_ROOM } from "../config.js";
import { GameError } from "./errors.js";

export interface Member {
  id: string;
  token: string;
  role: Role;
  name: string;
  socketIds: Set<string>;
  /** Patrons: this phone's device id (localStorage), so a new tab finds the same seat. */
  device?: string;
}

export interface Entry {
  id: string;
  /** The patron who signed up; null when the host added them by hand. */
  memberId: string | null;
  name: string;
  song?: string;
  artist?: string;
  note?: string;
  with?: string;
  status: EntryStatus;
  addedAt: number;
  startedAt?: number;
  turn?: number;
}

/** How the room talks to sockets, injected so Room has no socket.io dependency. */
export interface RoomTransport {
  sendState(socketId: string, view: RoomView): void;
  sendClosed(socketId: string, reason: string): void;
  sendNotice(socketId: string, message: string): void;
}

/** The links the host key and co-host invites go in (the box's host_link / cohost_link too). */
export const hostPath = (room: { code: string }, token: string) => `/join/${room.code}?host=${encodeURIComponent(token)}`;
export const cohostPath = (room: { code: string }, token: string) => `/join/${room.code}?cohost=${encodeURIComponent(token)}`;

export const TAKEOVER_NOTICE = "Staff took over hosting. You're a co-host now: you can still run the list.";
export const COHOST_REMOVED_NOTICE = "You're not a co-host any more.";

/** Finished entries kept for the host's history (and the per-night limit). */
const MAX_FINISHED_KEPT = 1000;
const HISTORY_SHOWN = 60;
const MINE_SHOWN = 20;

const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

export class Room implements KitRoom {
  readonly members = new Map<string, Member>();
  hostId = "";
  settings: RoomSettings = { ...DEFAULT_SETTINGS };
  /** Every signup tonight, in the order they were made. */
  private readonly entries = new Map<string, Entry>();
  /** Waiting entry ids, in line order. */
  private queue: string[] = [];
  private nowId: string | null = null;
  /** Performers so far tonight (the round number). */
  turns = 0;
  lastActivityAt = Date.now();
  readonly createdAt = Date.now();
  closed = false;
  kind: SessionKind;
  title?: string;
  /** Who may host (the kit's HostSeats): host key, first-joiner offer, take-over, co-host invites. */
  seats = new HostSeats();
  /** Set by the registry: a debounced players_changed (joins and leaves). */
  onPlayersChanged: () => void = () => {};

  constructor(
    readonly code: string,
    private readonly transport: RoomTransport,
    kind: SessionKind = "patron",
  ) {
    this.kind = kind;
  }

  // ------------------------------------------------------------- members

  addHost(name: string): Member {
    const m = this.newMember("host", cleanText(name, LIMITS.name) || "Host");
    this.hostId = m.id;
    return m;
  }

  /** The first phone into a "first joiner hosts" room takes the host seat. */
  claimHostSeat(rawName: string | undefined): Member {
    const host = this.members.get(this.hostId);
    if (!host || this.seats.claimForJoiner() !== "host") throw new GameError("BAD_REQUEST");
    host.name = cleanText(rawName, LIMITS.name) || "Host";
    return host;
  }

  /** The seat a token opens: a member's own token, or the host link's key (the host seat). */
  seatFor(token: unknown): Member | undefined {
    if (typeof token !== "string" || !token) return undefined;
    return this.findByToken(token) ?? (this.seats.isHostToken(token) ? this.members.get(this.hostId) : undefined);
  }

  /** Anyone attached to a seat. For the host seat this closes the first-joiner offer. */
  noteAttached(member: Member): void {
    if (member.role === "host") this.seats.hostAttached(member.id);
  }

  /** A patron phone. A known device id gets its seat back (a new tab, a cleared session). */
  addPatron(device: unknown): Member {
    const dev = typeof device === "string" && DEVICE_RE.test(device) ? device : undefined;
    const known = this.patronByDevice(dev);
    if (known) return known;
    if (this.patrons().length >= MAX_PATRONS_PER_ROOM) throw new GameError("ROOM_FULL");
    const m = this.newMember("patron", "");
    m.device = dev;
    this.playersChanged();
    return m;
  }

  /** The patron seat this phone's device id already holds, if any. */
  patronByDevice(device: unknown): Member | undefined {
    if (typeof device !== "string" || !DEVICE_RE.test(device)) return undefined;
    for (const m of this.members.values()) if (m.role === "patron" && m.device === device) return m;
    return undefined;
  }

  addTable(): Member {
    if (this.tables().length >= MAX_TABLES_PER_ROOM) throw new GameError("ROOM_FULL");
    return this.newMember("table", "TV");
  }

  /** A co-host invite was redeemed: a new co-host, or a patron phone already here promoted. */
  seatCohost(existing: Member | undefined, rawName: string | undefined): Member {
    if (existing && existing.role !== "patron") return existing;
    const name = cleanText(rawName, LIMITS.name);
    if (!name && !existing?.name) throw new GameError("NAME_REQUIRED");
    if (this.cohosts().length >= MAX_COHOSTS_PER_ROOM) throw new GameError("ROOM_FULL");
    let m = existing;
    if (m) {
      m.role = "cohost";
      if (name) m.name = name;
      this.playersChanged();
    } else {
      m = this.newMember("cohost", name);
    }
    this.seats.addCohost(m.id);
    return m;
  }

  /** Staff took over (host_link): the old host's phone stays on as a co-host; a fresh seat waits. */
  takeOver(previous: string | undefined): void {
    const old = previous ? this.members.get(previous) : undefined;
    if (!old || old.role !== "host") return;
    old.role = "cohost";
    this.hostId = this.newMember("host", "Venue").id;
    this.notify(old, TAKEOVER_NOTICE);
  }

  /** A co-host is a patron again. */
  demoteCohost(memberId: string): void {
    const m = this.members.get(memberId);
    this.seats.removeCohost(memberId);
    if (!m || m.role !== "cohost") return;
    m.role = "patron";
    this.playersChanged();
    this.notify(m, COHOST_REMOVED_NOTICE);
  }

  removeMember(memberId: string, reason: string): void {
    const m = this.members.get(memberId);
    if (!m) return;
    for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
    this.members.delete(memberId);
    this.seats.removeCohost(memberId);
    if (m.role === "patron") this.playersChanged();
  }

  private newMember(role: Role, name: string): Member {
    const m: Member = { id: newId(), token: newToken(), role, name, socketIds: new Set() };
    this.members.set(m.id, m);
    return m;
  }

  private notify(m: Member, message: string): void {
    for (const sid of m.socketIds) this.transport.sendNotice(sid, message);
  }

  findByToken(token: string): Member | undefined {
    for (const m of this.members.values()) if (m.token === token) return m;
    return undefined;
  }

  attachSocket(member: Member, socketId: string): void {
    member.socketIds.add(socketId);
  }

  detachSocket(memberId: string, socketId: string): void {
    this.members.get(memberId)?.socketIds.delete(socketId);
  }

  patrons(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "patron");
  }
  tables(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "table");
  }
  cohosts(): Member[] {
    return [...this.members.values()].filter((m) => m.role === "cohost");
  }

  /** Host or co-host: runs the list. */
  requireRunner(memberId: string): void {
    if (!this.seats.canRun(memberId)) throw new GameError("NOT_HOST");
  }
  /** The host only: closing the room, co-host invites. */
  requireHost(memberId: string): void {
    if (this.seats.roleOf(memberId) !== "host") throw new GameError("NOT_HOST");
  }
  requirePatron(memberId: string): Member {
    const m = this.members.get(memberId);
    if (!m || m.role !== "patron") throw new GameError("NOT_PATRON");
    return m;
  }

  private playersChanged(): void {
    if (!this.closed) this.onPlayersChanged();
  }

  // ------------------------------------------------------------- signups

  /** Whether this patron may sign up now (the host's limits). */
  gateFor(memberId: string): SignupGate {
    const code = this.gateCode(memberId);
    return code ? { ok: false, reason: new GameError(code).message } : { ok: true };
  }

  private gateCode(memberId: string): "SIGNUPS_PAUSED" | "ALREADY_IN_LINE" | "LIMIT_REACHED" | "QUEUE_FULL" | null {
    if (!this.settings.signupsOpen) return "SIGNUPS_PAUSED";
    const mine = this.entriesOf(memberId);
    if (this.settings.oneActive && mine.some((e) => e.status === "waiting" || e.status === "up")) return "ALREADY_IN_LINE";
    const max = this.settings.maxPerNight;
    if (max > 0 && mine.filter((e) => e.status !== "dropped").length >= max) return "LIMIT_REACHED";
    if (this.queue.length >= LIMITS.queue) return "QUEUE_FULL";
    return null;
  }

  /** A patron puts themselves on the list. */
  signUp(memberId: string, input: EntryInput): Entry {
    this.requirePatron(memberId);
    const entry = this.makeEntry(input, memberId);
    const refused = this.gateCode(memberId);
    if (refused) throw new GameError(refused);
    return this.enqueue(entry);
  }

  /** The host adds someone by hand (no phone). Not limited by the pause or the per-phone limits. */
  addEntry(input: EntryInput): Entry {
    if (this.queue.length >= LIMITS.queue) throw new GameError("QUEUE_FULL");
    return this.enqueue(this.makeEntry(input, null));
  }

  /** The host fixes a name or song (a typo, a change of song). */
  editEntry(entryId: string, input: EntryInput): void {
    const e = this.entry(entryId);
    const next = this.makeEntry({ ...e, ...input }, e.memberId);
    e.name = next.name;
    e.song = next.song;
    e.artist = next.artist;
    e.note = next.note;
    e.with = next.with;
  }

  private makeEntry(input: EntryInput, memberId: string | null): Entry {
    const name = cleanText(input?.name, LIMITS.name);
    if (!name) throw new GameError("NAME_REQUIRED");
    const song = cleanText(input?.song, LIMITS.song) || undefined;
    const karaoke = this.settings.mode === "karaoke";
    // A patron's karaoke signup needs a song; the host may add a name alone and fill it in later.
    if (karaoke && !song && memberId) throw new GameError("SONG_REQUIRED");
    return {
      id: newId(),
      memberId,
      name,
      song,
      artist: cleanText(input?.artist, LIMITS.artist) || undefined,
      note: cleanText(input?.note, LIMITS.note) || undefined,
      with: cleanText(input?.with, LIMITS.with) || undefined,
      status: "waiting",
      addedAt: Date.now(),
    };
  }

  private enqueue(entry: Entry): Entry {
    this.entries.set(entry.id, entry);
    this.queue.push(entry.id);
    this.prune();
    log.info("queue", "signed up", { code: this.code, by: entry.memberId ? "patron" : "host", waiting: this.queue.length });
    this.emit("x-signup-added", { name: entry.name, waiting: this.queue.length, byHost: entry.memberId === null });
    return entry;
  }

  /** A patron takes themselves off the list. */
  dropOut(memberId: string, entryId: string): void {
    this.requirePatron(memberId);
    const e = this.entries.get(entryId);
    if (!e || e.memberId !== memberId) throw new GameError("BAD_REQUEST");
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    this.unqueue(e.id);
    e.status = "dropped";
    log.info("queue", "dropped out", { code: this.code, waiting: this.queue.length });
  }

  // -------------------------------------------------------------- the host

  /** Drag to reorder: puts a waiting entry at `toIndex` (0 = next up). */
  moveEntry(entryId: string, toIndex: number): void {
    const e = this.entry(entryId);
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    if (!Number.isInteger(toIndex)) throw new GameError("BAD_REQUEST");
    this.unqueue(e.id);
    const at = Math.max(0, Math.min(this.queue.length, toIndex));
    this.queue.splice(at, 0, e.id);
  }

  /** To the end of the line. The performer on stage goes back in line too (the stage is then empty). */
  moveToEnd(entryId: string): void {
    const e = this.entry(entryId);
    if (e.status === "up") {
      this.leaveStage(e, "waiting");
    } else if (e.status === "waiting") {
      this.unqueue(e.id);
    } else {
      throw new GameError("NOT_WAITING");
    }
    this.queue.push(e.id);
  }

  /** Skips a waiting entry, or the performer on stage (a no-show). Out of the line; "Put back" undoes it. */
  skip(entryId: string): void {
    const e = this.entry(entryId);
    if (e.status === "up") {
      this.leaveStage(e, "skipped");
    } else if (e.status === "waiting") {
      this.unqueue(e.id);
      e.status = "skipped";
    } else {
      throw new GameError("NOT_WAITING");
    }
  }

  /** "Now on": this waiting entry goes on stage. Whoever was up is done. */
  nowOn(entryId: string): void {
    const e = this.entry(entryId);
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    const cur = this.current();
    if (cur) this.leaveStage(cur, "done");
    this.unqueue(e.id);
    this.bringUp(e);
  }

  /** "Next performer" (and the box's next_round): the current one is done, the first in line goes up. */
  nextPerformer(): void {
    const cur = this.current();
    if (!cur && this.queue.length === 0) throw new GameError("QUEUE_EMPTY");
    if (cur) this.leaveStage(cur, "done");
    const nextId = this.queue.shift();
    if (nextId) this.bringUp(this.entry(nextId));
  }

  /** "Done": the performer on stage is finished; the stage stays empty (a break). */
  finishCurrent(): void {
    const cur = this.current();
    if (!cur) throw new GameError("NOBODY_UP");
    this.leaveStage(cur, "done");
  }

  /** Puts a done, skipped or dropped entry back at the end of the line. */
  restore(entryId: string): void {
    const e = this.entry(entryId);
    if (e.status === "waiting" || e.status === "up") throw new GameError("BAD_REQUEST");
    if (this.queue.length >= LIMITS.queue) throw new GameError("QUEUE_FULL");
    e.status = "waiting";
    e.startedAt = undefined;
    this.queue.push(e.id);
  }

  setSignupsOpen(open: boolean): void {
    this.settings = { ...this.settings, signupsOpen: open };
    log.info("queue", open ? "signups opened" : "signups paused", { code: this.code });
  }

  setMessage(message: unknown): void {
    this.settings = { ...this.settings, message: cleanText(message, LIMITS.message) };
  }

  updateSettings(patch: Partial<RoomSettings>): void {
    const next = { ...this.settings };
    const p = patch ?? {};
    if (p.mode !== undefined) {
      if (p.mode !== "karaoke" && p.mode !== "openmic") throw new GameError("BAD_REQUEST");
      next.mode = p.mode;
    }
    if (p.signupsOpen !== undefined) next.signupsOpen = Boolean(p.signupsOpen);
    if (p.message !== undefined) next.message = cleanText(p.message, LIMITS.message);
    if (p.oneActive !== undefined) next.oneActive = Boolean(p.oneActive);
    const int = (v: unknown, { min, max }: { min: number; max: number }) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new GameError("BAD_REQUEST");
      return v;
    };
    if (p.maxPerNight !== undefined) next.maxPerNight = int(p.maxPerNight, LIMITS.maxPerNight);
    if (p.minutesPerTurn !== undefined) next.minutesPerTurn = int(p.minutesPerTurn, LIMITS.minutesPerTurn);
    if (p.tvNextCount !== undefined) next.tvNextCount = int(p.tvNextCount, LIMITS.tvNextCount);
    this.settings = next;
  }

  // ------------------------------------------------------------ internals

  current(): Entry | undefined {
    return this.nowId ? this.entries.get(this.nowId) : undefined;
  }

  waiting(): Entry[] {
    return this.queue.map((id) => this.entries.get(id)!).filter(Boolean);
  }

  private entry(entryId: unknown): Entry {
    const e = typeof entryId === "string" ? this.entries.get(entryId) : undefined;
    if (!e) throw new GameError("BAD_REQUEST");
    return e;
  }

  private entriesOf(memberId: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.memberId === memberId);
  }

  private unqueue(entryId: string): void {
    const i = this.queue.indexOf(entryId);
    if (i >= 0) this.queue.splice(i, 1);
  }

  private bringUp(e: Entry): void {
    this.turns += 1;
    e.status = "up";
    e.startedAt = Date.now();
    e.turn = this.turns;
    this.nowId = e.id;
    log.info("queue", "now on", { code: this.code, turn: this.turns, waiting: this.queue.length });
    this.emit("round_started", { round: this.turns, name: e.name });
    this.emit("x-signup-next", {
      round: this.turns,
      name: e.name,
      ...(e.song ? { song: e.song } : {}),
      ...(e.artist ? { artist: e.artist } : {}),
      ...(e.with ? { with: e.with } : {}),
      mode: this.settings.mode,
      waiting: this.queue.length,
    });
  }

  private leaveStage(e: Entry, status: "done" | "skipped" | "waiting"): void {
    if (this.nowId === e.id) this.nowId = null;
    e.status = status;
    if (status === "waiting") e.startedAt = undefined;
    this.emit("round_ended", { round: e.turn, name: e.name, result: status === "waiting" ? "moved" : status });
  }

  /** Drops the oldest finished entries past the cap (the per-night count goes by what's kept). */
  private prune(): void {
    if (this.entries.size <= MAX_FINISHED_KEPT + LIMITS.queue) return;
    for (const [id, e] of this.entries) {
      if (this.entries.size <= MAX_FINISHED_KEPT + LIMITS.queue) break;
      if (e.status !== "waiting" && e.status !== "up") this.entries.delete(id);
    }
  }

  private emit(type: "round_started" | "round_ended" | "x-signup-next" | "x-signup-added", data: Record<string, unknown>): void {
    bg.emit({ type, roomCode: this.code, sessionKind: this.kind, data });
  }

  // ---------------------------------------------- the game kit's KitRoom

  /** Patron phones (not the host, co-hosts or TVs). */
  playerCount(): number {
    return this.patrons().length;
  }
  /** TVs connected right now. A venue room isn't idle-closed while > 0. */
  tableCount(): number {
    return this.tables().filter((m) => m.socketIds.size > 0).length;
  }
  round(): number {
    return this.turns;
  }
  phase(): string {
    return this.settings.signupsOpen ? "open" : "paused";
  }
  hostConnected(): boolean {
    return (this.members.get(this.hostId)?.socketIds.size ?? 0) > 0;
  }
  hostName(): string | undefined {
    return this.members.get(this.hostId)?.name;
  }
  maxPlayers(): number {
    return MAX_PATRONS_PER_ROOM;
  }
  overviewExtra(): Partial<RoomOverview> {
    const cur = this.current();
    const parts = [
      this.title,
      cur ? `Now: ${cur.name}` : "Stage empty",
      `${this.queue.length} waiting`,
      this.settings.signupsOpen ? undefined : "signups paused",
    ].filter(Boolean);
    return { title: parts.join(" · ") };
  }

  // --------------------------------------------------------------- views

  broadcast(): void {
    this.lastActivityAt = Date.now();
    for (const m of this.members.values()) {
      if (m.socketIds.size === 0) continue;
      const view = this.viewFor(m);
      for (const sid of m.socketIds) this.transport.sendState(sid, view);
    }
  }

  sendStateTo(member: Member, socketId: string): void {
    this.transport.sendState(socketId, this.viewFor(member));
  }

  viewFor(m: Member): RoomView {
    const runner = m.role === "host" || m.role === "cohost";
    const toView = (e: Entry): EntryView => {
      const mine = m.role === "patron" && e.memberId === m.id;
      return {
        id: e.id,
        name: e.name,
        song: e.song,
        artist: e.artist,
        note: runner || mine ? e.note : undefined,
        with: e.with,
        status: e.status,
        addedAt: e.addedAt,
        startedAt: e.startedAt,
        byHost: e.memberId === null,
        mine,
        turn: e.turn,
      };
    };
    const cur = this.current();
    const finished = runner
      ? [...this.entries.values()]
          .filter((e) => e.status === "done" || e.status === "skipped" || e.status === "dropped")
          .sort((a, b) => (b.startedAt ?? b.addedAt) - (a.startedAt ?? a.addedAt))
          .slice(0, HISTORY_SHOWN)
      : [];
    return {
      code: this.code,
      title: this.title,
      you: { id: m.id, role: m.role, name: m.name },
      settings: { ...this.settings },
      now: cur ? toView(cur) : null,
      queue: this.waiting().map(toView),
      history: finished.map(toView),
      mine: m.role === "patron" ? this.entriesOf(m.id).reverse().slice(0, MINE_SHOWN).map(toView) : [],
      gate: m.role === "patron" ? this.gateFor(m.id) : { ok: true },
      turns: this.turns,
      patrons: this.patrons().length,
      tableCount: this.tables().length,
      cohosts:
        m.role === "host"
          ? this.cohosts().map((c) => ({ id: c.id, name: c.name, connected: c.socketIds.size > 0 }))
          : [],
      serverTime: Date.now(),
    };
  }

  summary(): AdminRoomSummary {
    return {
      code: this.code,
      kind: this.kind,
      title: this.title,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      mode: this.settings.mode,
      signupsOpen: this.settings.signupsOpen,
      waiting: this.queue.length,
      turns: this.turns,
      now: this.current()?.name,
      hostConnected: this.hostConnected(),
      patrons: this.patrons().length,
      tables: this.tables().length,
    };
  }

  close(reason: string, _cause?: CloseCause): void {
    if (this.closed) return;
    this.closed = true;
    for (const m of this.members.values()) for (const sid of m.socketIds) this.transport.sendClosed(sid, reason);
  }
}
