import { config } from "../../config";
import { configStore } from "../../storage/config_store";
import type { CommandMiddleware, CommandMiddlewareContext } from "./types";

const cooldowns = new Map<string, number>();
let cooldownLastPruneAt = 0;

function getCooldownKey(context: CommandMiddlewareContext): string {
  const { messageType, groupId, userId, command } = context;
  if (messageType === "group" && typeof groupId === "number") {
    return `g:${groupId}:${userId}:${command.definition.name}`;
  }
  return `p:${userId}:${command.definition.name}`;
}

function getEffectiveCooldownEntryTtlMs(cooldownMs: number): number {
  const configured = Math.max(0, Math.floor(config.permissions.cooldownEntryTtlMs));
  if (configured > 0) {
    return configured;
  }
  return Math.max(cooldownMs * 3, 5 * 60 * 1000);
}

function pruneCooldowns(now: number, cooldownMs: number): void {
  const pruneIntervalMs = Math.max(1, Math.floor(config.permissions.cooldownPruneIntervalMs));
  if (cooldownLastPruneAt > 0 && now - cooldownLastPruneAt < pruneIntervalMs) {
    return;
  }

  const ttlMs = getEffectiveCooldownEntryTtlMs(cooldownMs);
  for (const [key, timestamp] of cooldowns.entries()) {
    if (now - timestamp > ttlMs) {
      cooldowns.delete(key);
    }
  }

  cooldownLastPruneAt = now;
}

function evictCooldownOverflow(): void {
  const maxKeys = Math.max(1, Math.floor(config.permissions.cooldownMaxKeys));
  const overflow = cooldowns.size - maxKeys;
  if (overflow <= 0) return;

  const sorted = Array.from(cooldowns.entries()).sort((left, right) => left[1] - right[1]);
  for (let index = 0; index < overflow; index += 1) {
    const item = sorted[index];
    if (!item) break;
    cooldowns.delete(item[0]);
  }
}

export const groupEnabledMiddleware: CommandMiddleware = async (context, next) => {
  if (
    context.messageType === "group" &&
    typeof context.groupId === "number" &&
    !configStore.isGroupEnabled(context.groupId) &&
    !context.command.definition.allowWhenGroupDisabled
  ) {
    await context.sendText("本群已关闭");
    return;
  }
  await next();
};

export const permissionMiddleware: CommandMiddleware = async (context, next) => {
  const access = context.command.definition.access ?? "root";
  if (access === "user") {
    await next();
    return;
  }

  if (access === "root" && !context.isRoot) {
    await context.sendText("无权限");
    return;
  }

  await next();
};

export const cooldownMiddleware: CommandMiddleware = async (context, next) => {
  const cooldownMs = configStore.getCooldownMs();
  if (cooldownMs <= 0) {
    cooldowns.clear();
    cooldownLastPruneAt = 0;
    await next();
    return;
  }

  const now = Date.now();
  pruneCooldowns(now, cooldownMs);

  if (context.command.definition.cooldownExempt) {
    await next();
    return;
  }

  const key = getCooldownKey(context);
  const last = cooldowns.get(key) ?? 0;
  const remaining = cooldownMs - (now - last);
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    await context.sendText(`冷却中，请稍后再试 (${seconds}s)`);
    return;
  }

  cooldowns.set(key, now);
  evictCooldownOverflow();
  await next();
};

export const defaultCommandMiddlewares: CommandMiddleware[] = [
  groupEnabledMiddleware,
  permissionMiddleware,
  cooldownMiddleware,
];

export async function runMiddlewares(
  context: CommandMiddlewareContext,
  middlewares: readonly CommandMiddleware[],
  execute: () => Promise<void>,
): Promise<void> {
  let index = -1;

  const dispatch = async (current: number): Promise<void> => {
    if (current <= index) {
      throw new Error("middleware next() 调用顺序错误");
    }
    index = current;

    if (current >= middlewares.length) {
      await execute();
      return;
    }

    const middleware = middlewares[current];
    await middleware(context, () => dispatch(current + 1));
  };

  await dispatch(0);
}
