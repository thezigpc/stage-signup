// The app's single connection to a Bar Games box.
//
// Off a box (no BG_CORE_URL / BG_GAME_TOKEN env) every call here is a no-op and the app runs
// as a plain web app: that's guaranteed by the SDK.

import { wireBarGames } from "@bargames/gamekit/bargames";
import { createBarGames, type CommandResult } from "@bargames/sdk/server";
import type { IncomingMessage } from "node:http";
import { DEFAULT_GAME_NAME } from "@signup/shared";
import { createVenueRoom, type Rooms } from "./rooms/registry.js";
import { cohostPath, hostPath, type Room } from "./rooms/Room.js";
import { GameError } from "./rooms/errors.js";

export const bg = createBarGames({
  gameId: "signup",
  defaultName: process.env.GAME_NAME || DEFAULT_GAME_NAME,
});

/** True when running on a box. Guards anything box-only. */
export const onBox = bg.connected;

/** Real client IP for rate limits and logs (the gateway's on a box, else cf-connecting-ip or the socket). */
export const clientIp = (req: IncomingMessage): string => bg.clientIp(req);

/** Display name: the venue's rename on a box, otherwise GAME_NAME. */
export async function displayName(fallback: string): Promise<string> {
  return onBox ? (await bg.venue()).game.displayName : fallback;
}

/** Same text the host's own "Close room" sends to everyone in the room. */
export const HOST_CLOSE_REASON = "The host closed tonight's list.";

/**
 * Level 3, through the game kit's wireBarGames: status, room_created / room_closed /
 * players_changed, create_room, next_round, end and the hosting commands. Each command runs
 * the same Room method as the host's button, then broadcasts.
 */
export function registerBarGames(rooms: Rooms): void {
  wireBarGames<Room>(bg, rooms, {
    // The box starts a room for its TVs. No host phone: hostUrl opens the empty host seat
    // on the staff iPad; with firstJoinerHosts the first phone in takes it instead.
    createVenueRoom: ({ kind, title, firstJoinerHosts }) => {
      const { room, hostToken } = createVenueRoom(rooms, kind ?? "venue", title, firstJoinerHosts === true);
      room.broadcast();
      return { room, hostUrl: hostPath(room, hostToken) };
    },
    commands: {
      // The host's "Next performer": whoever is on finishes, the first in line goes up.
      next_round: (room): CommandResult => {
        try {
          room.nextPerformer();
        } catch (err) {
          if (err instanceof GameError) return { ok: false, message: err.message };
          throw err;
        }
        room.broadcast();
        const up = room.current();
        return { ok: true, message: up ? `${up.name} is up.` : "The stage is empty." };
      },
    },
    seats: {
      of: (room) => room.seats,
      hostPath,
      cohostPath,
      onTakeover: (room, previous) => {
        room.takeOver(previous);
        room.broadcast();
      },
      onCohostRemoved: (room, memberId) => {
        room.demoteCohost(memberId);
        room.broadcast();
      },
    },
    endReason: HOST_CLOSE_REASON,
    endCause: "host",
  });
}
