// Socket protocol shared by the server and the client. The server is authoritative: the
// client renders a RoomView and sends intents; every rule is checked on the server.

export const DEFAULT_GAME_NAME = "Stage Signup";

/** host: runs the queue. cohost: the same, but can't close the room or invite co-hosts. patron: a phone signing up. table: the TV. */
export type Role = "host" | "cohost" | "patron" | "table";

/** Karaoke takes a song and artist; open mic takes a free note (for the host only). */
export type Mode = "karaoke" | "openmic";

/**
 * waiting: in line. up: on stage now. done: performed. skipped: the host skipped them
 * (a no-show). dropped: they took themselves off the list.
 */
export type EntryStatus = "waiting" | "up" | "done" | "skipped" | "dropped";

export interface RoomSettings {
  mode: Mode;
  /** False while the host has paused signups (the host can still add people by hand). */
  signupsOpen: boolean;
  /** The host's message to the queue ("10 minute break"), on the TV and phones. "" for none. */
  message: string;
  /** One signup in line (or on stage) per phone at a time. */
  oneActive: boolean;
  /** Most signups per phone tonight (done, skipped and in line all count; drop-outs don't). 0 = no limit. */
  maxPerNight: number;
  /** Minutes per turn, for the estimated wait. */
  minutesPerTurn: number;
  /** How many of the next performers the TV lists. */
  tvNextCount: number;
}

export const DEFAULT_SETTINGS: RoomSettings = {
  mode: "karaoke",
  signupsOpen: true,
  message: "",
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
  title: 60,
  maxPerNight: { min: 0, max: 20 },
  minutesPerTurn: { min: 1, max: 30 },
  tvNextCount: { min: 3, max: 5 },
  /** Entries waiting at once. */
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
  /** Open mic note: only the host, co-hosts and the patron who wrote it see it. */
  note?: string;
  with?: string;
  status: EntryStatus;
  addedAt: number;
  /** When this entry went on stage (status "up"). */
  startedAt?: number;
  /** Added by the host by hand (someone without a phone). */
  byHost: boolean;
  /** This phone's own signup. */
  mine: boolean;
  /** Performer number tonight, once they've been on stage. */
  turn?: number;
}

export interface PersonView {
  id: string;
  name: string;
  connected: boolean;
}

/** Whether this phone may sign up right now, and why not. */
export interface SignupGate {
  ok: boolean;
  reason?: string;
}

export interface RoomView {
  code: string;
  title?: string;
  you: { id: string; role: Role; name: string };
  settings: RoomSettings;
  /** On stage now. */
  now: EntryView | null;
  /** In line, in order. */
  queue: EntryView[];
  /** Done, skipped and dropped, most recent first (hosts only; patrons get their own in `mine`). */
  history: EntryView[];
  /** This phone's signups tonight, newest first (patrons). */
  mine: EntryView[];
  gate: SignupGate;
  /** Performers so far tonight. */
  turns: number;
  /** Patrons (phones) in the room. */
  patrons: number;
  tableCount: number;
  /** Hosts only. */
  cohosts: PersonView[];
  serverTime: number;
}

export interface JoinResult {
  code: string;
  token: string;
  memberId: string;
  role: Role;
  name: string;
}

export interface RoomInfo {
  mode: Mode;
  title?: string;
}

export interface AdminRoomSummary {
  code: string;
  kind: string;
  title?: string;
  createdAt: number;
  lastActivityAt: number;
  mode: Mode;
  signupsOpen: boolean;
  waiting: number;
  turns: number;
  now?: string;
  hostConnected: boolean;
  patrons: number;
  tables: number;
}

export interface AdminSettings {
  roomIdleMinutes: number;
}

export interface AdminOverview {
  rooms: AdminRoomSummary[];
  settings: AdminSettings;
  serverTime: number;
}

export const ADMIN_SETTINGS_LIMITS = {
  roomIdleMinutes: { min: 5, max: 7 * 24 * 60 },
} as const;

type Ack<T = object> = (res: ({ ok: true } & T) | { ok: false; error: string }) => void;

export interface ClientToServerEvents {
  createRoom: (req: { name?: string; mode?: Mode; title?: string }, ack: Ack<JoinResult>) => void;
  roomInfo: (req: { code: string }, ack: Ack<RoomInfo>) => void;
  joinRoom: (
    req: { code: string; role: "patron" | "table"; name?: string; token?: string; device?: string; cohost?: string },
    ack: Ack<JoinResult>,
  ) => void;
  resume: (req: { code: string; token: string }, ack: Ack<JoinResult>) => void;
  leaveRoom: (ack: Ack) => void;
  closeRoom: (ack: Ack) => void;

  // patrons
  signUp: (req: EntryInput, ack: Ack<{ entryId: string }>) => void;
  dropOut: (entryId: string, ack: Ack) => void;

  // host and co-hosts
  addEntry: (req: EntryInput, ack: Ack<{ entryId: string }>) => void;
  editEntry: (req: { entryId: string } & EntryInput, ack: Ack) => void;
  moveEntry: (req: { entryId: string; toIndex: number }, ack: Ack) => void;
  moveToEnd: (entryId: string, ack: Ack) => void;
  skipEntry: (entryId: string, ack: Ack) => void;
  nowOn: (entryId: string, ack: Ack) => void;
  restoreEntry: (entryId: string, ack: Ack) => void;
  nextPerformer: (ack: Ack) => void;
  finishCurrent: (ack: Ack) => void;
  setSignupsOpen: (open: boolean, ack: Ack) => void;
  setMessage: (message: string, ack: Ack) => void;
  updateSettings: (patch: Partial<RoomSettings>, ack: Ack) => void;

  // host only
  cohostInvite: (ack: Ack<{ path: string; expiresAt: string }>) => void;
  removeCohost: (memberId: string, ack: Ack) => void;
}

export interface ServerToClientEvents {
  state: (view: RoomView) => void;
  closed: (payload: { reason: string }) => void;
  notice: (payload: { message: string }) => void;
}

export const ERRORS = {
  BAD_REQUEST: "That request wasn't valid.",
  ROOM_NOT_FOUND: "There's no room with that code. Check the code and try again.",
  ROOM_FULL: "This room is full.",
  NOT_IN_ROOM: "You're not in a room. Join one from the home page.",
  BAD_TOKEN: "This device's seat in the room has expired. Join again from the home page.",
  NOT_HOST: "Only the host can do that.",
  NOT_PATRON: "Only a phone that joined the list can do that.",
  NAME_REQUIRED: "Enter a name.",
  SONG_REQUIRED: "Enter the song you'll sing.",
  SIGNUPS_PAUSED: "Signups are paused right now. Try again in a bit.",
  ALREADY_IN_LINE: "You're already on the list. You can sign up again after your turn.",
  LIMIT_REACHED: "You've reached tonight's signup limit.",
  QUEUE_FULL: "The list is full right now.",
  NOT_WAITING: "That signup isn't in line any more.",
  NOBODY_UP: "Nobody is on stage right now.",
  QUEUE_EMPTY: "Nobody is waiting in line.",
  BAD_INVITE: "That co-host link has expired or was already used. Ask the host for a new one.",
  RATE_LIMITED: "Too many tries. Wait a minute and try again.",
} as const;

export type ErrorCode = keyof typeof ERRORS;

/** Trims, collapses inner whitespace and cuts to `max` characters. Non-strings become "". */
export function cleanText(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
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
