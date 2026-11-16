// The venue's stages: their setup (DATA_DIR/stages.json, edited by staff on /admin) and
// tonight's lists (DATA_DIR/tonight.json, saved shortly after every change so an update or
// restart keeps the queue).

import { log, type JsonStore } from "@bargames/gamekit/server";
import { DEFAULT_STAGE, LIMITS, cleanText, slugify, type PublicStage, type StageConfig } from "@signup/shared";
import { GameError } from "../errors.js";
import { Stage, type StageEvent, type StageState } from "./Stage.js";

const CONFIG_FILE = "stages.json";
const STATE_FILE = "tonight.json";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const int = (v: unknown, { min, max }: { min: number; max: number }, fallback: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : fallback;

/** A saved or posted stage setup, cleaned: bad values fall back to the defaults (or `prev`). */
export function cleanConfig(raw: unknown, prev?: StageConfig): StageConfig | null {
  if (!isObj(raw)) return null;
  const base = prev ?? { ...DEFAULT_STAGE, id: "", name: "" };
  const id = typeof raw.id === "string" && /^[a-z0-9-]{1,24}$/.test(raw.id) ? raw.id : base.id;
  const name = raw.name === undefined ? base.name : cleanText(raw.name, LIMITS.stageName);
  if (!id || !name) return null;
  return {
    id,
    name,
    enabled: raw.enabled === undefined ? base.enabled : raw.enabled === true,
    mode: raw.mode === "openmic" || raw.mode === "karaoke" ? raw.mode : base.mode,
    oneActive: raw.oneActive === undefined ? base.oneActive : raw.oneActive === true,
    maxPerNight: int(raw.maxPerNight, LIMITS.maxPerNight, base.maxPerNight),
    minutesPerTurn: int(raw.minutesPerTurn, LIMITS.minutesPerTurn, base.minutesPerTurn),
    tvNextCount: int(raw.tvNextCount, LIMITS.tvNextCount, base.tvNextCount),
  };
}

export class Stages {
  /** In the staff's order. */
  private list: Stage[] = [];
  private saveTimer: NodeJS.Timeout | null = null;
  private saving: Promise<void> = Promise.resolve();
  /** A stage's list or setup changed: send its views. `gone`: it was turned off or removed. */
  onChange: (stageId: string, gone?: boolean) => void = () => {};
  /** A stage event, for the box. */
  onEvent: (stage: Stage, e: StageEvent) => void = () => {};

  constructor(
    private readonly store: JsonStore,
    private readonly saveDelayMs: number,
  ) {}

  async init(): Promise<void> {
    const saved = await this.store.read<unknown>(CONFIG_FILE);
    const configs: StageConfig[] = [];
    if (isObj(saved) && Array.isArray(saved.stages)) {
      for (const raw of saved.stages) {
        const c = cleanConfig(raw);
        if (c && !configs.some((x) => x.id === c.id)) configs.push(c);
      }
    }
    // A fresh install (or 0.1.0's data, which had no stages): one stage, "Main stage".
    if (configs.length === 0) configs.push({ ...DEFAULT_STAGE, id: "main", name: "Main stage" });
    this.list = configs.slice(0, LIMITS.stages).map((c) => this.wire(new Stage(c)));
    const state = await this.store.read<unknown>(STATE_FILE);
    if (isObj(state) && isObj(state.stages)) {
      for (const s of this.list) s.loadState((state.stages as Record<string, Partial<StageState>>)[s.config.id]);
    }
    await this.saveConfig();
  }

  private wire(s: Stage): Stage {
    s.onEvent = (e) => this.onEvent(s, e);
    return s;
  }

  all(): Stage[] {
    return [...this.list];
  }

  get(id: unknown): Stage | undefined {
    return typeof id === "string" ? this.list.find((s) => s.config.id === id) : undefined;
  }

  /** The stages patrons can pick from: on, in order. */
  open(): Stage[] {
    return this.list.filter((s) => s.config.enabled);
  }

  publicList(): PublicStage[] {
    return this.open().map((s) => ({ id: s.config.id, name: s.config.name, mode: s.config.mode }));
  }

  /** ?stage=<id>, or with none (or one that's off) the first stage that's on. */
  resolve(id: unknown): Stage | undefined {
    const s = this.get(id);
    if (s?.config.enabled) return s;
    return id === undefined || id === "" ? this.open()[0] : undefined;
  }

  // -------------------------------------------------------- staff setup

  async create(raw: unknown): Promise<StageConfig> {
    if (this.list.length >= LIMITS.stages) throw new GameError("TOO_MANY_STAGES");
    const name = cleanText(isObj(raw) ? raw.name : undefined, LIMITS.stageName);
    if (!name) throw new GameError("NAME_REQUIRED");
    let id = slugify(name);
    for (let n = 2; this.get(id); n++) id = `${slugify(name).slice(0, 20)}-${n}`;
    const config = cleanConfig({ ...(isObj(raw) ? raw : {}), id, name }, { ...DEFAULT_STAGE, id, name })!;
    this.list.push(this.wire(new Stage(config)));
    await this.saveConfig();
    log.info("stages", "added", { stage: id });
    return config;
  }

  async update(id: string, raw: unknown): Promise<StageConfig> {
    const s = this.get(id);
    if (!s) throw new GameError("BAD_REQUEST");
    const next = cleanConfig({ ...(isObj(raw) ? raw : {}), id }, s.config);
    if (!next) throw new GameError("NAME_REQUIRED");
    const wasOn = s.config.enabled;
    s.config = next;
    await this.saveConfig();
    this.onChange(id, wasOn && !next.enabled);
    return next;
  }

  async remove(id: string): Promise<void> {
    const s = this.get(id);
    if (!s) throw new GameError("BAD_REQUEST");
    if (this.list.length === 1) throw new GameError("BAD_REQUEST");
    this.list = this.list.filter((x) => x !== s);
    await this.saveConfig();
    this.scheduleSave();
    this.onChange(id, true);
    log.info("stages", "removed", { stage: id });
  }

  /** Staff's order: the ids in the new order (any left out keep their place at the end). */
  async reorder(ids: unknown): Promise<void> {
    if (!Array.isArray(ids)) throw new GameError("BAD_REQUEST");
    const picked = ids.map((id) => this.get(id)).filter((s): s is Stage => Boolean(s));
    this.list = [...new Set([...picked, ...this.list])];
    await this.saveConfig();
  }

  private saveConfig(): Promise<void> {
    return this.store.write(CONFIG_FILE, { stages: this.list.map((s) => s.config) });
  }

  // ------------------------------------------------------- tonight's lists

  /** After any change to a list: send it out, and save soon. */
  changed(stage: Stage): void {
    this.onChange(stage.config.id);
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveState();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  private saveState(): Promise<void> {
    const body = { stages: Object.fromEntries(this.list.map((s) => [s.config.id, s.toState()])) };
    this.saving = this.saving
      .then(() => this.store.write(STATE_FILE, body))
      .catch((err) => log.error("stages", "couldn't save tonight's lists", { err: String(err) }));
    return this.saving;
  }

  /** Shutdown: write now. */
  async flush(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    await this.saveState();
  }
}
