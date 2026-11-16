// Protocol shared by the server and the client. The server is authoritative.
//
// 0.2.0: an app, not a game. No rooms or room codes: the venue has stages (set up by staff
// on /admin), each with its own list. Patrons sign up over the socket, keyed by a per-device
// id. The list is run over HTTP (/api/run), by staff or by a guest host from the box.

export const DEFAULT_GAME_NAME = "Stage Signup";

/** Karaoke takes a song and artist; open mic takes a free note (for the hosts only). */
export type Mode = "karaoke" | "openmic";

/**
 * waiting: in line. up: on stage now. done: performed. skipped: the host skipped them
 * (a no-show). dropped: they took themselves off the list.
 */
export type EntryStatus = "waiting" | "up" | "done" | "skipped" | "dropped";

/** A stage's setup: staff only (the admin page). */
export interface StageConfig {
  /** Stable slug, in ?stage= links. */
  id: string;
  name: string;
  enabled: boolean;
  mode: Mode;
  /** One signup in line (or on stage) per phone at a time. */
  oneActive: boolean;
  /** Most signups per phone per night (done, skipped and in line count; drop-outs don't). 0 = no limit. */
  maxPerNight: number;
  /** Minutes per turn, for the estimated wait. */
  minutesPerTurn: number;
  /** How many of the next performers the TV lists. */
  tvNextCount: number;
}

/** What the person running the list changes during the night (staff or a guest host). */
export interface StageLive {
  signupsOpen: boolean;
  /** The message to the queue ("10 minute break"), on the TV and phones. "" for none. */
  message: string;
}

export const DEFAULT_STAGE: Omit<StageConfig, "id" | "name"> = {
  enabled: true,
  mode: "karaoke",
  oneActive: true,
  maxPerNight: 0,
  minutesPerTurn: 5,
  tvNextCount: 5,
};

export const LIMITS = {
  name: 30,
  song: 80,
  artist: 60,
  note: 140,
  with: 60,
  message: 140,
  stageName: 40,
  cohostName: 40,
  stages: 12,
  maxPerNight: { min: 0, max: 20 },
  minutesPerTurn: { min: 1, max: 30 },
  tvNextCount: { min: 3, max: 5 },
  /** Entries waiting at once, per stage. */
  queue: 300,
} as const;

export interface EntryInput {
  name?: string;
  song?: string;
  artist?: string;
  note?: string;
  /** "With a friend": the duet partner or group, free text. */
  with?: string;
}

export interface EntryView {
  id: string;
  name: string;
  song?: string;
  artist?: string;
  /** Open mic note: only whoever runs the list and the patron who wrote it see it. */
  note?: string;
  with?: string;
  status: EntryStatus;
  addedAt: number;
  startedAt?: number;
  /** Added by hand (a walk-up without a phone). */
  byHost: boolean;
  /** This phone's own signup. */
  mine: boolean;
  /** Performer number tonight, once they've been on stage. */
  turn?: number;
}

/** Whether this phone may sign up right now, and why not. */
export interface SignupGate {
  ok: boolean;
  reason?: string;
}

export type ViewerRole = "patron" | "tv" | "runner";

export interface StageView {
  stage: { id: string; name: string; mode: Mode; enabled: boolean };
  live: StageLive;
  /** The stage's limits and TV settings (for the wait estimate and the TV). */
  config: Pick<StageConfig, "oneActive" | "maxPerNight" | "minutesPerTurn" | "tvNextCount">;
  role: ViewerRole;
  now: EntryView | null;
  queue: EntryView[];
  /** Done, skipped and dropped, most recent first (runners only). */
  history: EntryView[];
  /** This phone's signups tonight, newest first (patrons). */
  mine: EntryView[];
  gate: SignupGate;
  /** Performers so far tonight. */
  turns: number;
  /** When "New night" last cleared this list. */
  nightStartedAt: number;
  serverTime: number;
}

/** GET /api/stages: the stages patrons can pick from (enabled, in order). */
export interface PublicStage {
  id: string;
  name: string;
  mode: Mode;
}

/** GET /api/run/me: who is running the list. */
export interface RunnerInfo {
  /** staff: the app's admin session or box staff. guest: a guest link from the box. */
  kind: "staff" | "guest";
  guest?: { id: string; role: "host" | "cohost"; name: string };
  /** A guest host may add co-hosts (manifest guests.cohosts; the venue's switch is checked when adding). */
  canAddCohosts: boolean;
}

export interface CohostLink {
  id: string;
  label: string;
  expiresAt: string;
}

export interface AdminStages {
  stages: StageConfig[];
}

type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  /** Sent on EVERY connect: which stage this socket shows, and as what. */
  watch: (req: { stage: string; role: ViewerRole; device?: string }, ack: Ack<{ stage: string }>) => void;
  signUp: (req: EntryInput, ack: Ack<{ entryId: string }>) => void;
  dropOut: (entryId: string, ack: Ack) => void;
}

export interface ServerToClientEvents {
  state: (view: StageView) => void;
  /** The stage was turned off or removed; patrons go back to the picker. */
  gone: (payload: { reason: string }) => void;
}

export const ERRORS = {
  BAD_REQUEST: "That request wasn't valid.",
  NO_STAGE: "That stage isn't taking signups. Pick another one.",
  NO_DEVICE: "This browser can't keep your place (private mode?). Try another browser.",
  NAME_REQUIRED: "Enter a name.",
  SONG_REQUIRED: "Enter the song you'll sing.",
  SIGNUPS_PAUSED: "Signups are paused right now. Try again in a bit.",
  ALREADY_IN_LINE: "You're already on the list. You can sign up again after your turn.",
  LIMIT_REACHED: "You've reached tonight's signup limit.",
  QUEUE_FULL: "The list is full right now.",
  NOT_WAITING: "That signup isn't in line any more.",
  NOBODY_UP: "Nobody is on stage right now.",
  QUEUE_EMPTY: "Nobody is waiting in line.",
  RATE_LIMITED: "Too many tries. Wait a minute and try again.",
  TOO_MANY_STAGES: "That's the most stages this app keeps.",
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** Trims, collapses inner whitespace and cuts to `max` characters. Non-strings become "". */
export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** A stage name → a short id for ?stage= links ("Back Room" → "back-room"). */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "stage"
  );
}

/**
 * Minutes until the entry at `position` (1 = next) goes on, from minutes per turn and how
 * long the current performer has been up. A rough guess, rounded to whole minutes.
 */
export function estimatedWait(position: number, minutesPerTurn: number, nowStartedAt: number | undefined, now: number): number {
  if (position < 1) return 0;
  const turnMs = minutesPerTurn * 60_000;
  const current = nowStartedAt === undefined ? 0 : Math.max(60_000, turnMs - Math.max(0, now - nowStartedAt));
  return Math.max(1, Math.round((current + (position - 1) * turnMs) / 60_000));
}
