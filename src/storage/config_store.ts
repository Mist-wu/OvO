import fs from "node:fs";
import path from "node:path";

import { logger } from "../utils/logger";
import { config } from "../config";

type GroupFeatureState = {
  chatEnabled?: boolean;
  commandEnabled?: boolean;
};

type GroupFeatureMap = Record<string, GroupFeatureState>;

type PersistentConfig = {
  cooldownMs: number;
  groupFeatures: GroupFeatureMap;
};

type ConfigStoreDefaults = {
  cooldownMs: number;
  groupFeatures?: GroupFeatureMap;
};

type StoredConfigV3 = PersistentConfig & {
  version: 3;
};

const CURRENT_CONFIG_VERSION = 3;

function normalizeCooldown(value: unknown, fallback: number): number {
  if (typeof value !== "number") return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function normalizeGroupIdKey(raw: unknown): string | undefined {
  const parsed = typeof raw === "number" || typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return String(parsed);
}

function normalizeGroupFeatureState(value: unknown): GroupFeatureState | undefined {
  if (typeof value === "boolean") {
    return {
      chatEnabled: value,
      commandEnabled: value,
    };
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as {
    chatEnabled?: unknown;
    commandEnabled?: unknown;
  };
  const state: GroupFeatureState = {};
  if (typeof parsed.chatEnabled === "boolean") {
    state.chatEnabled = parsed.chatEnabled;
  }
  if (typeof parsed.commandEnabled === "boolean") {
    state.commandEnabled = parsed.commandEnabled;
  }
  return state.chatEnabled === undefined && state.commandEnabled === undefined ? undefined : state;
}

function normalizeGroupFeatures(value: unknown, fallback: GroupFeatureMap): GroupFeatureMap {
  if (!value || typeof value !== "object") {
    return { ...fallback };
  }

  const normalized: GroupFeatureMap = {};
  for (const [rawKey, rawState] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeGroupIdKey(rawKey);
    if (!key) continue;
    const state = normalizeGroupFeatureState(rawState);
    if (!state) continue;
    normalized[key] = state;
  }
  return normalized;
}

function normalizeConfig(
  input: Partial<PersistentConfig> & { groupEnabled?: unknown },
  defaults: PersistentConfig,
): PersistentConfig {
  const groupFeaturesInput =
    input.groupFeatures && typeof input.groupFeatures === "object"
      ? input.groupFeatures
      : input.groupEnabled;

  return {
    cooldownMs: normalizeCooldown(input.cooldownMs ?? defaults.cooldownMs, defaults.cooldownMs),
    groupFeatures: normalizeGroupFeatures(groupFeaturesInput, defaults.groupFeatures),
  };
}

function toStoredConfigV3(
  input: Partial<PersistentConfig> & { groupEnabled?: unknown },
  defaults: PersistentConfig,
): StoredConfigV3 {
  const normalized = normalizeConfig(input, defaults);
  return {
    version: 3,
    cooldownMs: normalized.cooldownMs,
    groupFeatures: normalized.groupFeatures,
  };
}

function migrateConfig(raw: unknown, defaults: PersistentConfig): StoredConfigV3 {
  if (!raw || typeof raw !== "object") {
    return toStoredConfigV3(defaults, defaults);
  }

  const parsed = raw as Record<string, unknown>;
  const version = parsed.version;

  if (version === CURRENT_CONFIG_VERSION) {
    return toStoredConfigV3(parsed as Partial<PersistentConfig>, defaults);
  }

  if (typeof version === "number" && version > CURRENT_CONFIG_VERSION) {
    logger.warn(
      `[config_store] 检测到更高配置版本 version=${version}，将按 v${CURRENT_CONFIG_VERSION} 字段兼容读取`,
    );
  }

  return toStoredConfigV3(parsed as Partial<PersistentConfig> & { groupEnabled?: unknown }, defaults);
}

export class ConfigStore {
  private data: StoredConfigV3;
  private readonly defaults: PersistentConfig;
  private readonly groupEnabledDefault: boolean;

  constructor(
    private readonly filePath: string,
    defaults: ConfigStoreDefaults,
  ) {
    this.groupEnabledDefault = config.permissions.groupEnabledDefault;
    this.defaults = {
      cooldownMs: normalizeCooldown(defaults.cooldownMs, 0),
      groupFeatures: normalizeGroupFeatures(defaults.groupFeatures, {}),
    };
    this.data = toStoredConfigV3(this.defaults, this.defaults);
    this.load();
  }

  get snapshot(): PersistentConfig {
    return {
      cooldownMs: this.data.cooldownMs,
      groupFeatures: { ...this.data.groupFeatures },
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

  isGroupChatEnabled(groupId: number | string): boolean {
    const state = this.getGroupState(groupId);
    if (state?.chatEnabled !== undefined) return state.chatEnabled;
    return this.groupEnabledDefault;
  }

  setGroupChatEnabled(groupId: number | string, enabled: boolean): boolean {
    return this.setGroupStateField(groupId, "chatEnabled", enabled);
  }

  isGroupCommandEnabled(groupId: number | string): boolean {
    const state = this.getGroupState(groupId);
    if (state?.commandEnabled !== undefined) return state.commandEnabled;
    return this.groupEnabledDefault;
  }

  setGroupCommandEnabled(groupId: number | string, enabled: boolean): boolean {
    return this.setGroupStateField(groupId, "commandEnabled", enabled);
  }

  private getGroupState(groupId: number | string): GroupFeatureState | undefined {
    const key = normalizeGroupIdKey(groupId);
    if (!key) return undefined;
    return this.data.groupFeatures[key];
  }

  private setGroupStateField(
    groupId: number | string,
    field: keyof GroupFeatureState,
    enabled: boolean,
  ): boolean {
    const key = normalizeGroupIdKey(groupId);
    if (!key) return false;

    const prev = this.data.groupFeatures[key] ?? {};
    if (prev[field] === enabled) return true;

    const next: GroupFeatureState = {
      ...prev,
      [field]: enabled,
    };

    if (next.chatEnabled === this.groupEnabledDefault) {
      delete next.chatEnabled;
    }
    if (next.commandEnabled === this.groupEnabledDefault) {
      delete next.commandEnabled;
    }

    if (next.chatEnabled === undefined && next.commandEnabled === undefined) {
      if (this.data.groupFeatures[key]) {
        delete this.data.groupFeatures[key];
        this.persist();
      }
      return true;
    }

    this.data.groupFeatures[key] = next;
    this.persist();
    return true;
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
      this.data = toStoredConfigV3(this.defaults, this.defaults);
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
  groupFeatures: {},
};

export const configStore = new ConfigStore(resolveConfigPath(), defaultConfig);
