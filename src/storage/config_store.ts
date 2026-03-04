import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger";
import { config } from "../config";

type PersistentConfig = {
  cooldownMs: number;
};

type StoredConfigV2 = PersistentConfig & {
  version: 2;
};

const CURRENT_CONFIG_VERSION = 2;

function normalizeCooldown(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeConfig(input: Partial<PersistentConfig>, defaults: PersistentConfig): PersistentConfig {
  return {
    cooldownMs: normalizeCooldown(input.cooldownMs ?? defaults.cooldownMs, defaults.cooldownMs),
  };
}

function toStoredConfigV2(input: Partial<PersistentConfig>, defaults: PersistentConfig): StoredConfigV2 {
  const normalized = normalizeConfig(input, defaults);
  return {
    version: 2,
    cooldownMs: normalized.cooldownMs,
  };
}

function migrateConfig(raw: unknown, defaults: PersistentConfig): StoredConfigV2 {
  if (!raw || typeof raw !== "object") {
    return toStoredConfigV2(defaults, defaults);
  }

  const parsed = raw as Record<string, unknown>;
  const version = parsed.version;

  if (version === CURRENT_CONFIG_VERSION) {
    return toStoredConfigV2(parsed as Partial<PersistentConfig>, defaults);
  }

  if (typeof version === "number" && version > CURRENT_CONFIG_VERSION) {
    logger.warn(
      `[config_store] 检测到更高配置版本 version=${version}，将按 v${CURRENT_CONFIG_VERSION} 字段兼容读取`,
    );
  }

  return toStoredConfigV2(parsed as Partial<PersistentConfig>, defaults);
}

export class ConfigStore {
  private data: StoredConfigV2;

  constructor(
    private readonly filePath: string,
    private readonly defaults: PersistentConfig,
  ) {
    this.data = toStoredConfigV2(defaults, defaults);
    this.load();
  }

  get snapshot(): PersistentConfig {
    return {
      cooldownMs: this.data.cooldownMs,
    };
  }

  getCooldownMs(): number {
    return this.data.cooldownMs;
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
      this.data = toStoredConfigV2(this.defaults, this.defaults);
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
  cooldownMs: config.permissions.cooldownMs,
};

export const configStore = new ConfigStore(resolveConfigPath(), defaultConfig);
