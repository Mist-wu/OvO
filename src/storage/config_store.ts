import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger";
import { config } from "../config";

export type PersistentConfig = {
  groupEnabled: Record<string, boolean>;
  cooldownMs: number;
};

type StoredConfigV1 = PersistentConfig & {
  version: 1;
};

const CURRENT_CONFIG_VERSION = 1;

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

function toStoredConfigV1(input: Partial<PersistentConfig>, defaults: PersistentConfig): StoredConfigV1 {
  const normalized = normalizeConfig(input, defaults);
  return {
    version: 1,
    groupEnabled: normalized.groupEnabled,
    cooldownMs: normalized.cooldownMs,
  };
}

function migrateConfig(raw: unknown, defaults: PersistentConfig): StoredConfigV1 {
  if (!raw || typeof raw !== "object") {
    return toStoredConfigV1(defaults, defaults);
  }

  const parsed = raw as Record<string, unknown>;
  const version = parsed.version;

  if (version === CURRENT_CONFIG_VERSION) {
    return toStoredConfigV1(parsed as Partial<PersistentConfig>, defaults);
  }

  if (typeof version === "number" && version > CURRENT_CONFIG_VERSION) {
    logger.warn(
      `[config_store] 检测到更高配置版本 version=${version}，将按 v${CURRENT_CONFIG_VERSION} 字段兼容读取`,
    );
  }

  return toStoredConfigV1(parsed as Partial<PersistentConfig>, defaults);
}

export class ConfigStore {
  private data: StoredConfigV1;

  constructor(
    private readonly filePath: string,
    private readonly defaults: PersistentConfig,
  ) {
    this.data = toStoredConfigV1(defaults, defaults);
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
      const parsed = JSON.parse(raw) as unknown;
      this.data = migrateConfig(parsed, this.defaults);
      const rawVersion =
        parsed && typeof parsed === "object"
          ? (parsed as { version?: unknown }).version
          : undefined;
      if (rawVersion !== CURRENT_CONFIG_VERSION) {
        this.persist();
      }
    } catch (error) {
      logger.warn("[config_store] 配置文件读取失败，已回退默认配置:", error);
      this.data = toStoredConfigV1(this.defaults, this.defaults);
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
