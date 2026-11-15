import { createSettingStore } from "@bargames/gamekit/server";
import { ADMIN_SETTINGS_LIMITS, type AdminSettings } from "@signup/shared";
import { DEFAULT_ROOM_IDLE_MINUTES, store } from "../config.js";

// Admin settings in DATA_DIR/settings.json (atomic writes; a damaged file is left
// untouched while the defaults apply).
const settings = createSettingStore<AdminSettings>({
  store,
  file: "settings.json",
  defaults: { roomIdleMinutes: DEFAULT_ROOM_IDLE_MINUTES },
  normalize: clean,
});

export const initAdminSettings = () => settings.init();
export const getAdminSettings = (): AdminSettings => settings.get();

export async function updateAdminSettings(patch: Partial<AdminSettings>): Promise<AdminSettings> {
  return settings.set(validate(patch));
}

const idleOk = (n: number) =>
  Number.isFinite(n) && n >= ADMIN_SETTINGS_LIMITS.roomIdleMinutes.min && n <= ADMIN_SETTINGS_LIMITS.roomIdleMinutes.max;

function clean(s: AdminSettings): AdminSettings {
  const n = Math.round(Number(s.roomIdleMinutes));
  return { roomIdleMinutes: idleOk(n) ? n : DEFAULT_ROOM_IDLE_MINUTES };
}

function validate(patch: Partial<AdminSettings>): Partial<AdminSettings> {
  const out: Partial<AdminSettings> = {};
  if (patch.roomIdleMinutes !== undefined) {
    const { min, max } = ADMIN_SETTINGS_LIMITS.roomIdleMinutes;
    const n = Math.round(Number(patch.roomIdleMinutes));
    if (!idleOk(n)) throw new Error(`Idle time must be between ${min} and ${max} minutes.`);
    out.roomIdleMinutes = n;
  }
  return out;
}
