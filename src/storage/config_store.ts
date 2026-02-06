import fs from "node:fs";
import path from "node:path";

import { config } from "../config";

export type PersistentConfig = {
  groupEnabled: Record<string, boolean>;
  cooldownMs: number;
};

function normalizeGroupEnabled(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== "object") return {};
  const result: Record<string, boolean> = {};
  for (const [key, rawValue] of Object.entries(value as Record<string, unknown>)) {
    if (rawValue === true || rawValue === false) {
      result[String(key)] = rawValue;
    }
  }
  return result;
}

function normalizeCooldown(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeConfig(input: Partial<PersistentConfig>, defaults: PersistentConfig): PersistentConfig {
  return {
    groupEnabled: normalizeGroupEnabled(input.groupEnabled ?? defaults.groupEnabled),
    cooldownMs: normalizeCooldown(input.cooldownMs ?? defaults.cooldownMs, defaults.cooldownMs),
  };
}

export class ConfigStore {
  private data: PersistentConfig;

  constructor(
    private readonly filePath: string,
    private readonly defaults: PersistentConfig,
  ) {
    this.data = normalizeConfig(defaults, defaults);
    this.load();
  }

  get snapshot(): PersistentConfig {
    return {
      groupEnabled: { ...this.data.groupEnabled },
      cooldownMs: this.data.cooldownMs,
    };
  }

  isGroupEnabled(groupId: number): boolean {
    const key = String(groupId);
    if (key in this.data.groupEnabled) return this.data.groupEnabled[key];
    return config.permissions.groupEnabledDefault;
  }

  getCooldownMs(): number {
    return this.data.cooldownMs;
  }

  setGroupEnabled(groupId: number, enabled: boolean): void {
    const key = String(groupId);
    if (this.data.groupEnabled[key] === enabled) return;
    this.data.groupEnabled = { ...this.data.groupEnabled, [key]: enabled };
    this.persist();
  }

  setCooldownMs(value: number): void {
    const next = Math.max(0, Math.floor(value));
    if (this.data.cooldownMs === next) return;
    this.data.cooldownMs = next;
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.persist();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistentConfig>;
      this.data = normalizeConfig(parsed, this.defaults);
    } catch (error) {
      console.warn("[config_store] 配置文件读取失败，已回退默认配置:", error);
      this.data = normalizeConfig(this.defaults, this.defaults);
      this.persist();
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify(this.data, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
    fs.renameSync(tmpPath, this.filePath);
  }
}

function resolveConfigPath(): string {
  const raw = config.permissions.configPath || "data/bot_config.json";
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const defaultConfig: PersistentConfig = {
  groupEnabled: {},
  cooldownMs: config.permissions.cooldownMs,
};

export const configStore = new ConfigStore(resolveConfigPath(), defaultConfig);
