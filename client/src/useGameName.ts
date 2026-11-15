import { useGameName as kitUseGameName } from "@bargames/gamekit/client";
import { DEFAULT_GAME_NAME } from "@signup/shared";
import { serverUrl } from "./socket";

/** The app's display name (GAME_NAME on the server; the venue's rename on a box). Sets document.title. */
export const useGameName = (): string => kitUseGameName(serverUrl, DEFAULT_GAME_NAME);
