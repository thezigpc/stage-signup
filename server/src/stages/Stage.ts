import {
  LIMITS,
  cleanText,
  type EntryInput,
  type EntryStatus,
  type EntryView,
  type StageConfig,
  type StageLive,
  type StageView,
  type SignupGate,
  type ViewerRole,
} from "@signup/shared";
import { log, newId } from "@bargames/gamekit/server";
import { GameError } from "../errors.js";

export interface Entry {
  id: string;
  /** The phone that signed up (its device id); null when added by hand. */
  device: string | null;
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

/** What's saved to disk, so an update or restart keeps tonight's list. */
export interface StageState {
  entries: Entry[];
  queue: string[];
  nowId: string | null;
  turns: number;
  live: StageLive;
  nightStartedAt: number;
}

/** Events the list raises; the registry sends them to the box (and saves). */
export type StageEvent =
  | { type: "added"; entry: Entry; waiting: number }
  | { type: "up"; entry: Entry; waiting: number }
  | { type: "off"; entry: Entry; result: "done" | "skipped" | "moved" }
  | { type: "signups"; open: boolean }
  | { type: "night" };

const MAX_FINISHED_KEPT = 1000;
const HISTORY_SHOWN = 60;
const MINE_SHOWN = 20;
export const DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** One stage's list for the night. Its setup (name, mode, limits) lives in the registry. */
export class Stage {
  private entries = new Map<string, Entry>();
  private queue: string[] = [];
  private nowId: string | null = null;
  turns = 0;
  live: StageLive = { signupsOpen: true, message: "" };
  nightStartedAt = Date.now();
  /** Set by the registry. */
  onEvent: (e: StageEvent) => void = () => {};

  constructor(public config: StageConfig) {}

  // ------------------------------------------------------------- signups

  gateFor(device: string | null | undefined): SignupGate {
    const code = this.gateCode(device);
    return code ? { ok: false, reason: new GameError(code).message } : { ok: true };
  }

  private gateCode(device: string | null | undefined) {
    if (!this.config.enabled) return "NO_STAGE" as const;
    if (!this.live.signupsOpen) return "SIGNUPS_PAUSED" as const;
    if (!device) return "NO_DEVICE" as const;
    const mine = this.entriesOf(device);
    if (this.config.oneActive && mine.some((e) => e.status === "waiting" || e.status === "up")) return "ALREADY_IN_LINE" as const;
    const max = this.config.maxPerNight;
    if (max > 0 && mine.filter((e) => e.status !== "dropped").length >= max) return "LIMIT_REACHED" as const;
    if (this.queue.length >= LIMITS.queue) return "QUEUE_FULL" as const;
    return null;
  }

  /** A patron's phone puts them on the list. */
  signUp(device: string, input: EntryInput): Entry {
    const entry = this.makeEntry(input, device);
    const refused = this.gateCode(device);
    if (refused) throw new GameError(refused);
    return this.enqueue(entry);
  }

  /** Added by hand (a walk-up). Not limited by the pause or the per-phone limits. */
  addEntry(input: EntryInput): Entry {
    if (this.queue.length >= LIMITS.queue) throw new GameError("QUEUE_FULL");
    return this.enqueue(this.makeEntry(input, null));
  }

  editEntry(entryId: unknown, input: EntryInput): void {
    const e = this.entry(entryId);
    const next = this.makeEntry({ ...e, ...input }, e.device);
    e.name = next.name;
    e.song = next.song;
    e.artist = next.artist;
    e.note = next.note;
    e.with = next.with;
  }

  private makeEntry(input: EntryInput, device: string | null): Entry {
    const name = cleanText(input?.name, LIMITS.name);
    if (!name) throw new GameError("NAME_REQUIRED");
    const song = cleanText(input?.song, LIMITS.song) || undefined;
    // A patron's karaoke signup needs a song; a walk-up can be a name alone, filled in later.
    if (this.config.mode === "karaoke" && !song && device) throw new GameError("SONG_REQUIRED");
    return {
      id: newId(),
      device,
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
    log.info("queue", "signed up", { stage: this.config.id, by: entry.device ? "patron" : "host", waiting: this.queue.length });
    this.onEvent({ type: "added", entry, waiting: this.queue.length });
    return entry;
  }

  /** A patron takes themselves off the list. */
  dropOut(device: string, entryId: unknown): void {
    const e = this.entry(entryId);
    if (e.device !== device) throw new GameError("BAD_REQUEST");
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    this.unqueue(e.id);
    e.status = "dropped";
  }

  // ------------------------------------------------- running the list

  /** Drag to reorder: puts a waiting entry at `toIndex` (0 = next up). */
  moveEntry(entryId: unknown, toIndex: unknown): void {
    const e = this.entry(entryId);
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    if (typeof toIndex !== "number" || !Number.isInteger(toIndex)) throw new GameError("BAD_REQUEST");
    this.unqueue(e.id);
    this.queue.splice(Math.max(0, Math.min(this.queue.length, toIndex)), 0, e.id);
  }

  /** To the end of the line. The performer on stage goes back in line too (the stage is then empty). */
  moveToEnd(entryId: unknown): void {
    const e = this.entry(entryId);
    if (e.status === "up") this.leaveStage(e, "waiting");
    else if (e.status === "waiting") this.unqueue(e.id);
    else throw new GameError("NOT_WAITING");
    this.queue.push(e.id);
  }

  /** Skips a waiting entry, or the performer on stage (a no-show). "Put back" undoes it. */
  skip(entryId: unknown): void {
    const e = this.entry(entryId);
    if (e.status === "up") this.leaveStage(e, "skipped");
    else if (e.status === "waiting") {
      this.unqueue(e.id);
      e.status = "skipped";
    } else throw new GameError("NOT_WAITING");
  }

  /** "Now on": this waiting entry goes on stage. Whoever was up is done. */
  nowOn(entryId: unknown): void {
    const e = this.entry(entryId);
    if (e.status !== "waiting") throw new GameError("NOT_WAITING");
    const cur = this.current();
    if (cur) this.leaveStage(cur, "done");
    this.unqueue(e.id);
    this.bringUp(e);
  }

  /** "Next performer": the current one is done, the first in line goes up. */
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
  restore(entryId: unknown): void {
    const e = this.entry(entryId);
    if (e.status === "waiting" || e.status === "up") throw new GameError("BAD_REQUEST");
    if (this.queue.length >= LIMITS.queue) throw new GameError("QUEUE_FULL");
    e.status = "waiting";
    e.startedAt = undefined;
    this.queue.push(e.id);
  }

  setSignupsOpen(open: boolean): void {
    if (this.live.signupsOpen === open) return;
    this.live = { ...this.live, signupsOpen: open };
    this.onEvent({ type: "signups", open });
  }

  setMessage(message: unknown): void {
    this.live = { ...this.live, message: cleanText(message, LIMITS.message) };
  }

  /** "New night": clears the list, the history and the per-phone counts. Signups open, no message. */
  newNight(): void {
    this.entries.clear();
    this.queue = [];
    this.nowId = null;
    this.turns = 0;
    this.live = { signupsOpen: true, message: "" };
    this.nightStartedAt = Date.now();
    log.info("queue", "new night", { stage: this.config.id });
    this.onEvent({ type: "night" });
  }

  // ------------------------------------------------------------ internals

  current(): Entry | undefined {
    return this.nowId ? this.entries.get(this.nowId) : undefined;
  }

  waiting(): Entry[] {
    return this.queue.map((id) => this.entries.get(id)).filter((e): e is Entry => Boolean(e));
  }

  private entry(entryId: unknown): Entry {
    const e = typeof entryId === "string" ? this.entries.get(entryId) : undefined;
    if (!e) throw new GameError("BAD_REQUEST");
    return e;
  }

  private entriesOf(device: string): Entry[] {
    return [...this.entries.values()].filter((e) => e.device === device);
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
    log.info("queue", "now on", { stage: this.config.id, turn: this.turns, waiting: this.queue.length });
    this.onEvent({ type: "up", entry: e, waiting: this.queue.length });
  }

  private leaveStage(e: Entry, status: "done" | "skipped" | "waiting"): void {
    if (this.nowId === e.id) this.nowId = null;
    e.status = status;
    if (status === "waiting") e.startedAt = undefined;
    this.onEvent({ type: "off", entry: e, result: status === "waiting" ? "moved" : status });
  }

  private prune(): void {
    const cap = MAX_FINISHED_KEPT + LIMITS.queue;
    if (this.entries.size <= cap) return;
    for (const [id, e] of this.entries) {
      if (this.entries.size <= cap) break;
      if (e.status !== "waiting" && e.status !== "up") this.entries.delete(id);
    }
  }

  // ------------------------------------------------------------ views

  viewFor(role: ViewerRole, device?: string): StageView {
    const runner = role === "runner";
    const toView = (e: Entry): EntryView => {
      const mine = role === "patron" && !!device && e.device === device;
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
        byHost: e.device === null,
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
    const c = this.config;
    return {
      stage: { id: c.id, name: c.name, mode: c.mode, enabled: c.enabled },
      live: { ...this.live },
      config: { oneActive: c.oneActive, maxPerNight: c.maxPerNight, minutesPerTurn: c.minutesPerTurn, tvNextCount: c.tvNextCount },
      role,
      now: cur ? toView(cur) : null,
      queue: this.waiting().map(toView),
      history: finished.map(toView),
      mine: role === "patron" && device ? this.entriesOf(device).reverse().slice(0, MINE_SHOWN).map(toView) : [],
      gate: role === "patron" ? this.gateFor(device) : { ok: true },
      turns: this.turns,
      nightStartedAt: this.nightStartedAt,
      serverTime: Date.now(),
    };
  }

  // ------------------------------------------------------------ saving

  toState(): StageState {
    return {
      entries: [...this.entries.values()],
      queue: [...this.queue],
      nowId: this.nowId,
      turns: this.turns,
      live: { ...this.live },
      nightStartedAt: this.nightStartedAt,
    };
  }

  /** Loads a saved list, dropping anything that doesn't add up (a hand-edited file). */
  loadState(s: Partial<StageState> | undefined): void {
    if (!s || typeof s !== "object") return;
    const entries = Array.isArray(s.entries) ? s.entries : [];
    const statuses: EntryStatus[] = ["waiting", "up", "done", "skipped", "dropped"];
    for (const raw of entries) {
      if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || !statuses.includes(raw.status)) continue;
      const device = typeof raw.device === "string" && DEVICE_RE.test(raw.device) ? raw.device : null;
      this.entries.set(raw.id, { ...raw, device });
    }
    this.queue = (Array.isArray(s.queue) ? s.queue : []).filter((id) => this.entries.get(id)?.status === "waiting");
    // Waiting entries missing from the order go to the end.
    for (const e of this.entries.values()) if (e.status === "waiting" && !this.queue.includes(e.id)) this.queue.push(e.id);
    const up = typeof s.nowId === "string" ? this.entries.get(s.nowId) : undefined;
    this.nowId = up?.status === "up" ? up.id : null;
    for (const e of this.entries.values()) if (e.status === "up" && e.id !== this.nowId) e.status = "done";
    this.turns = Number.isInteger(s.turns) && (s.turns as number) >= 0 ? (s.turns as number) : 0;
    this.live = {
      signupsOpen: s.live?.signupsOpen !== false,
      message: cleanText(s.live?.message, LIMITS.message),
    };
    this.nightStartedAt = typeof s.nightStartedAt === "number" ? s.nightStartedAt : Date.now();
  }
}
