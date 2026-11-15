import { createSessionStore } from "@bargames/gamekit/client";
import type { EntryInput, Role } from "@signup/shared";

export interface StoredSession {
  roomCode: string;
  token: string;
  name: string;
  role: Role;
}

// The kit's session store: the seat is per tab ("signup_session:<tab id>") and lives in
// localStorage. Every key starts with "signup_": on a box every game shares the origin.
export const sessions = createSessionStore<StoredSession>("signup");

export const loadSession = (): StoredSession | null => sessions.load();
export const saveSession = (s: StoredSession): void => sessions.save(s);
export const clearSession = (): void => sessions.clear();

/**
 * This phone's device id ("signup_device"), sent when joining: a new tab or a rescanned QR
 * code finds the same place in line, and the host's one-per-phone limit holds.
 */
export function deviceId(): string {
  let id = sessions.pref("device");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    sessions.setPref("device", id);
  }
  return id;
}

/** The last signup typed on this device ("signup_last"), to prefill the form. */
export const lastSignup = (): EntryInput => sessions.json<EntryInput>("last") ?? {};
export const rememberSignup = (e: EntryInput): void => sessions.setJson("last", e);
