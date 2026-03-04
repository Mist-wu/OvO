import "dotenv/config";

function numberFromEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumberFromEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanFromEnv(value: string | undefined, fallback = false): boolean {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

type ExternalServiceConfig = {
  retries: number;
  retryDelayMs: number;
  concurrency: number;
  degradeOnFailure: boolean;
};

function externalServiceConfig(
  envPrefix: string,
  defaults: ExternalServiceConfig,
): ExternalServiceConfig {
  return {
    retries: numberFromEnv(process.env[`${envPrefix}_RETRIES`], defaults.retries),
    retryDelayMs: numberFromEnv(process.env[`${envPrefix}_RETRY_DELAY_MS`], defaults.retryDelayMs),
    concurrency: numberFromEnv(process.env[`${envPrefix}_CONCURRENCY`], defaults.concurrency),
    degradeOnFailure: booleanFromEnv(
      process.env[`${envPrefix}_DEGRADE_ON_FAILURE`],
      defaults.degradeOnFailure,
    ),
  };
}

function quoteModeFromEnv(value: string | undefined): "auto" | "on" | "off" {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "on" || normalized === "off" || normalized === "auto") {
    return normalized;
  }
  return "auto";
}

const napcatHost = process.env.NAPCAT_HOST ?? "127.0.0.1";
const napcatPort = numberFromEnv(process.env.NAPCAT_PORT, 3001);
const napcatPath = process.env.NAPCAT_WS_PATH ?? "/ws";
const napcatToken =
  process.env.NAPCAT_TOKEN?.trim() || process.env.NAPCAT_ACCESS_TOKEN?.trim() || "";

const napcatUrl =
  process.env.NAPCAT_WS_URL?.trim() || `ws://${napcatHost}:${napcatPort}${napcatPath}`;

export const config = {
  napcat: {
    url: napcatUrl,
    token: napcatToken,
    reconnectMs: numberFromEnv(process.env.NAPCAT_RECONNECT_MS, 1000),
    heartbeatTimeoutMs: numberFromEnv(process.env.NAPCAT_HEARTBEAT_TIMEOUT_MS, 15000),
    actionTimeoutMs: numberFromEnv(process.env.NAPCAT_ACTION_TIMEOUT_MS, 10000),
    actionImageTimeoutMs: numberFromEnv(process.env.NAPCAT_ACTION_IMAGE_TIMEOUT_MS, 30000),
    actionLog: {
      enabled: booleanFromEnv(process.env.NAPCAT_ACTION_LOG_ENABLED, true),
      level: (["error", "warn", "info", "debug"] as const).find(
        (l) => l === process.env.NAPCAT_ACTION_LOG_LEVEL?.trim().toLowerCase(),
      ) ?? "info",
    },
    actionQueue: {
      concurrency: numberFromEnv(process.env.NAPCAT_ACTION_QUEUE_CONCURRENCY, 1),
      maxSize: numberFromEnv(process.env.NAPCAT_ACTION_QUEUE_MAX_SIZE, 200),
      rateLimitPerSecond: numberFromEnv(process.env.NAPCAT_ACTION_RATE_LIMIT_PER_SECOND, 20),
      retryAttempts: numberFromEnv(process.env.NAPCAT_ACTION_RETRY_ATTEMPTS, 1),
      retryBaseDelayMs: numberFromEnv(process.env.NAPCAT_ACTION_RETRY_BASE_DELAY_MS, 200),
      retryMaxDelayMs: numberFromEnv(process.env.NAPCAT_ACTION_RETRY_MAX_DELAY_MS, 1500),
    },
  },
  scheduler: {
    intervalMs: numberFromEnv(process.env.SCHEDULE_INTERVAL_MS, 60000),
  },
  welcome: {
    enabled: booleanFromEnv(process.env.WELCOME_ENABLED, false),
    message: process.env.WELCOME_MESSAGE ?? "欢迎 {user_id} 入群",
  },
  pokeReply: {
    enabled: booleanFromEnv(process.env.POKE_REPLY_ENABLED, false),
    message: process.env.POKE_REPLY_MESSAGE ?? "别戳啦~",
  },
  requests: {
    autoApproveGroup: booleanFromEnv(process.env.AUTO_APPROVE_GROUP_REQUESTS, false),
    autoApproveFriend: booleanFromEnv(process.env.AUTO_APPROVE_FRIEND_REQUESTS, false),
  },
  permissions: {
    rootUserId: optionalNumberFromEnv(process.env.ROOT_USER_ID),
    cooldownMs: numberFromEnv(process.env.COMMAND_COOLDOWN_MS, 0),
    cooldownMaxKeys: numberFromEnv(process.env.COMMAND_COOLDOWN_MAX_KEYS, 5000),
    cooldownPruneIntervalMs: numberFromEnv(process.env.COMMAND_COOLDOWN_PRUNE_INTERVAL_MS, 60 * 1000),
    cooldownEntryTtlMs: numberFromEnv(process.env.COMMAND_COOLDOWN_ENTRY_TTL_MS, 0),
    configPath: process.env.BOT_CONFIG_PATH?.trim() || "data/bot_config.json",
  },
  chat: {
    enabled: booleanFromEnv(process.env.CHAT_ENABLED, true),
    emptyReplyFallback: process.env.CHAT_EMPTY_REPLY_FALLBACK?.trim() || "刚卡了",
    maxReplyChars: numberFromEnv(process.env.CHAT_MAX_REPLY_CHARS, 1000),
    groundingEnabled: booleanFromEnv(process.env.CHAT_GROUNDING_ENABLED, true),
    groundingMetaLogEnabled: booleanFromEnv(process.env.CHAT_GROUNDING_META_LOG_ENABLED, true),
    mediaEnabled: booleanFromEnv(process.env.CHAT_MEDIA_ENABLED, true),
    mediaMaxImages: numberFromEnv(process.env.CHAT_MEDIA_MAX_IMAGES, 2),
    mediaFetchTimeoutMs: numberFromEnv(process.env.CHAT_MEDIA_FETCH_TIMEOUT_MS, 12000),
    mediaMaxBytes: numberFromEnv(process.env.CHAT_MEDIA_MAX_BYTES, 5 * 1024 * 1024),
    quoteMode: quoteModeFromEnv(process.env.CHAT_QUOTE_MODE),
    humanizeEnabled: booleanFromEnv(process.env.CHAT_HUMANIZE_ENABLED, true),
    humanizeTypoProb: numberFromEnv(process.env.CHAT_HUMANIZE_TYPO_PROB, 0.06),
    humanizeSplitProb: numberFromEnv(process.env.CHAT_HUMANIZE_SPLIT_PROB, 0.25),
  },
  llm: {
    gemini: {
      apiKey: process.env.GEMINI_API_KEY?.trim() || "",
      model: process.env.GEMINI_MODEL?.trim() || "gemini-3-flash-preview",
      imageModel: process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3-pro-image-preview",
      baseUrl: process.env.GEMINI_BASE_URL?.trim() || "https://generativelanguage.googleapis.com",
      timeoutMs: numberFromEnv(process.env.GEMINI_TIMEOUT_MS, 30000),
      imageTimeoutMs: numberFromEnv(process.env.GEMINI_IMAGE_TIMEOUT_MS, 120000),
    },
  },
  weather: {
    apiKey: process.env.WEATHER_API_KEY?.trim() || "",
    timeoutMs: numberFromEnv(process.env.WEATHER_TIMEOUT_MS, 8000),
  },
  external: {
    circuitBreakerEnabled: booleanFromEnv(process.env.EXTERNAL_CIRCUIT_BREAKER_ENABLED, true),
    circuitFailureThreshold: numberFromEnv(process.env.EXTERNAL_CIRCUIT_FAILURE_THRESHOLD, 3),
    circuitOpenMs: numberFromEnv(process.env.EXTERNAL_CIRCUIT_OPEN_MS, 30000),
    gemini: externalServiceConfig("GEMINI", {
      retries: 1,
      retryDelayMs: 200,
      concurrency: 2,
      degradeOnFailure: true,
    }),
    weather: externalServiceConfig("WEATHER", {
      retries: 1,
      retryDelayMs: 150,
      concurrency: 4,
      degradeOnFailure: true,
    }),
  },
};

