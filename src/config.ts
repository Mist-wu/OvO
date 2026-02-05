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

function actionLogLevelFromEnv(value: string | undefined, fallback = "info"): ActionLogLevel {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "error" || normalized === "warn" || normalized === "info" || normalized === "debug") {
    return normalized;
  }
  return fallback;
}

function numberListFromEnv(value: string | undefined): number[] {
  if (!value) return [];
  return value
    .split(/[\s,]+/)
    .map((item) => Number(item))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

type ActionLogLevel = "error" | "warn" | "info" | "debug";

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
    actionLog: {
      enabled: booleanFromEnv(process.env.NAPCAT_ACTION_LOG_ENABLED, true),
      level: actionLogLevelFromEnv(process.env.NAPCAT_ACTION_LOG_LEVEL, "info"),
    },
  },
  targetQq: optionalNumberFromEnv(process.env.NAPCAT_TARGET_QQ),
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
    admins: numberListFromEnv(process.env.BOT_ADMINS),
    whitelist: numberListFromEnv(process.env.BOT_WHITELIST),
    groupEnabledDefault: booleanFromEnv(process.env.GROUP_ENABLED_DEFAULT, true),
    cooldownMs: numberFromEnv(process.env.COMMAND_COOLDOWN_MS, 0),
    configPath: process.env.BOT_CONFIG_PATH?.trim() || "data/bot_config.json",
  },
};
