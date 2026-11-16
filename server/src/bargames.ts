// The app's single connection to a Bar Games box.
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and the app runs
// as a plain web app: guests never exist, events go nowhere.

import { createBarGames } from "@bargames/sdk/server";
import type { GuestInfo } from "@bargames/sdk";
import type { IncomingMessage } from "node:http";
import { DEFAULT_GAME_NAME } from "@signup/shared";
import type { Stage, StageEvent } from "./stages/Stage.js";

export const bg = createBarGames({
  gameId: "signup",
  defaultName: process.env.GAME_NAME || DEFAULT_GAME_NAME,
});

/** True when running on a box. Guards anything box-only. */
export const onBox = bg.connected;

/** Real client IP for rate limits (the gateway's on a box, else cf-connecting-ip or the socket). */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise GAME_NAME. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

/**
 * The guest host (or co-host) staff gave this app's controls to, from the box's guest link
 * (SDK 0.16.0). Asked on every request: links end at closing time or when staff turn them
 * off. Always undefined off a box.
 */
export const guestOf = (req: IncomingMessage): GuestInfo | undefined => (onBox ? bg.guest(req) : undefined);

/** Staff signed in to the box admin (always false off a box). */
export const isBoxStaff = (req: IncomingMessage): boolean => bg.isStaff(req);

// "N waiting", content-free, at most every 2 s per stage (for a Home Assistant sensor).
const waitingTimers = new Map<string, NodeJS.Timeout>();
const lastWaiting = new Map<string, number>();
export function noteWaiting(stage: Stage): void {
  if (!onBox) return;
  const id = stage.config.id;
  if (waitingTimers.has(id)) return;
  const t = setTimeout(() => {
    waitingTimers.delete(id);
    const waiting = stage.waiting().length;
    if (lastWaiting.get(id) === waiting) return;
    lastWaiting.set(id, waiting);
    bg.emit({ type: "x-signup-waiting", data: { stage: id, waiting } });
  }, 2000);
  t.unref?.();
  waitingTimers.set(id, t);
}

/**
 * A stage event, for scenes and lights. Names and songs that people typed only: the open
 * mic note never leaves the app. A no-op off a box.
 */
export function emitStageEvent(stage: Stage, e: StageEvent): void {
  if (!onBox) return;
  const id = stage.config.id;
  switch (e.type) {
    case "added":
      bg.emit({ type: "x-signup-added", data: { stage: id, name: e.entry.name, waiting: e.waiting, byHost: e.entry.device === null } });
      break;
    case "up":
      bg.emit({
        type: "x-signup-next",
        data: {
          stage: id,
          round: e.entry.turn,
          name: e.entry.name,
          ...(e.entry.song ? { song: e.entry.song } : {}),
          ...(e.entry.artist ? { artist: e.entry.artist } : {}),
          ...(e.entry.with ? { with: e.entry.with } : {}),
          mode: stage.config.mode,
          waiting: e.waiting,
        },
      });
      break;
    case "off":
      bg.emit({ type: "x-signup-ended", data: { stage: id, round: e.entry.turn, name: e.entry.name, result: e.result } });
      break;
    case "signups":
      bg.emit({ type: "x-signup-paused", data: { stage: id, paused: !e.open } });
      break;
    case "night":
      bg.emit({ type: "x-signup-new-night", data: { stage: id } });
      break;
  }
  noteWaiting(stage);
}
