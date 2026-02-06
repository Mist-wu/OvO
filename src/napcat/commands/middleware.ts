import { configStore } from "../../storage/config_store";
import type { CommandMiddleware, CommandMiddlewareContext } from "./types";

const cooldowns = new Map<string, number>();

function getCooldownKey(context: CommandMiddlewareContext): string {
  const { messageType, groupId, userId, command } = context;
  if (messageType === "group" && typeof groupId === "number") {
    return `g:${groupId}:${userId}:${command.definition.name}`;
  }
  return `p:${userId}:${command.definition.name}`;
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
  if (!context.isRoot) {
    await context.sendText("无权限");
    return;
  }

  await next();
};

export const cooldownMiddleware: CommandMiddleware = async (context, next) => {
  const cooldownMs = configStore.getCooldownMs();
  if (cooldownMs <= 0 || context.command.definition.cooldownExempt) {
    await next();
    return;
  }

  const key = getCooldownKey(context);
  const now = Date.now();
  const last = cooldowns.get(key) ?? 0;
  const remaining = cooldownMs - (now - last);
  if (remaining > 0) {
    const seconds = Math.ceil(remaining / 1000);
    await context.sendText(`冷却中，请稍后再试 (${seconds}s)`);
    return;
  }

  cooldowns.set(key, now);
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
