import { createSessionStore } from "@bargames/gamekit/client";
import type { EntryInput } from "@signup/shared";

// Per-device preferences. Every key starts with "signup_": on a box every app shares the origin.
const prefs = createSessionStore("signup");

/**
 * This phone's device id ("signup_device"). It's who a patron is: their place in line and
 * the host's per-phone limits follow it, across tabs and rescanned QR codes.
 */
export function deviceId(): string {
  let id = prefs.pref("device");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    const bytes = new Uint8Array(16);
    try {
      crypto.getRandomValues(bytes);
    } catch {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    prefs.setPref("device", id);
  }
  return id;
}

/** The last name typed on this device ("signup_last"), to prefill the form. */
export const lastSignup = (): EntryInput => prefs.json<EntryInput>("last") ?? {};
export const rememberSignup = (e: EntryInput): void => prefs.setJson("last", e);

/** The stage this host page last ran ("signup_kj_stage"). */
export const lastRunStage = (): string => prefs.pref("kj_stage");
export const rememberRunStage = (id: string): void => prefs.setPref("kj_stage", id);

// The admin session (the app's own password, or box staff), per tab. /admin and /kj share it.
const TOKEN_KEY = "signup_admin_token";
export const loadAdminToken = (): string => {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
};
export const saveAdminToken = (t: string): void => {
  try {
    if (t) sessionStorage.setItem(TOKEN_KEY, t);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode */
  }
};
