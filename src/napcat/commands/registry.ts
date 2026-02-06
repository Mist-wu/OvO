import { config } from "../../config";
import { configStore } from "../../storage/config_store";
import type { CommandDefinition, ParsedCommand } from "./types";

type EmptyPayload = Record<string, never>;

const emptyPayload: EmptyPayload = {};

export const helpText =
  "/ping /echo <text> /help /status /config " +
  "/group on|off [group_id] /cooldown [ms]";

function defineCommand<Payload>(
  definition: CommandDefinition<Payload>,
): CommandDefinition<unknown> {
  return definition as CommandDefinition<unknown>;
}

function splitParts(message: string): string[] {
  return message.trim().split(/\s+/);
}

function parseNumber(value: string, allowZero = false): number | null {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  if (allowZero) {
    if (parsed < 0) return null;
  } else if (parsed <= 0) {
    return null;
  }
  return parsed;
}

const builtInCommands: CommandDefinition<unknown>[] = [
  defineCommand({
    name: "ping",
    parse(message) {
      return message.trim() === "/ping" ? emptyPayload : null;
    },
    async execute(context) {
      await context.sendText("pong");
    },
  }),
  defineCommand({
    name: "echo",
    parse(message) {
      const trimmed = message.trim();
      if (!trimmed.startsWith("/echo ")) return null;
      return { text: trimmed.slice(6).trim() };
    },
    async execute(context, payload) {
      const text = (payload as { text?: string }).text || "(empty)";
      await context.sendText(text);
    },
  }),
  defineCommand({
    name: "help",
    cooldownExempt: true,
    parse(message) {
      return message.trim() === "/help" ? emptyPayload : null;
    },
    async execute(context) {
      await context.sendText(helpText);
    },
  }),
  defineCommand({
    name: "status",
    cooldownExempt: true,
    parse(message) {
      return message.trim() === "/status" ? emptyPayload : null;
    },
    async execute(context) {
      const runtime = context.client.getRuntimeStatus();
      const lastPongAgeMs = Math.max(0, Date.now() - runtime.lastPongAt);
      await context.sendText(
        `connected=${runtime.connected} reconnecting=${runtime.reconnecting} ` +
          `inflight=${runtime.inFlightActions} queued=${runtime.queuedActions} ` +
          `pending=${runtime.pendingActions} pong_age_ms=${lastPongAgeMs}`,
      );
    },
  }),
  defineCommand({
    name: "config",
    cooldownExempt: true,
    parse(message) {
      return message.trim() === "/config" ? emptyPayload : null;
    },
    async execute(context) {
      const snapshot = configStore.snapshot;
      const rootUserId =
        typeof config.permissions.rootUserId === "number"
          ? String(config.permissions.rootUserId)
          : "(unset)";
      await context.sendText(
        `rootUserId=${rootUserId} cooldownMs=${snapshot.cooldownMs} ` +
          `groupEnabledDefault=${config.permissions.groupEnabledDefault} ` +
          `autoApproveGroup=${config.requests.autoApproveGroup} ` +
          `autoApproveFriend=${config.requests.autoApproveFriend}`,
      );
    },
  }),
  defineCommand({
    name: "group_on",
    cooldownExempt: true,
    allowWhenGroupDisabled: true,
    parse(message) {
      const parts = splitParts(message);
      if (parts[0] !== "/group" || parts[1] !== "on" || parts.length < 2) {
        return null;
      }
      const rawGroupId = parts[2];
      if (!rawGroupId) return { groupId: undefined };
      const groupId = parseNumber(rawGroupId);
      if (groupId === null) return null;
      return { groupId };
    },
    async execute(context, payload) {
      const parsed = payload as { groupId?: number };
      const targetGroupId =
        typeof parsed.groupId === "number" ? parsed.groupId : context.groupId;
      if (typeof targetGroupId !== "number") {
        await context.sendText("请在群内使用或提供群号");
        return;
      }
      configStore.setGroupEnabled(targetGroupId, true);
      await context.sendText(`已开启群 ${targetGroupId}`);
    },
  }),
  defineCommand({
    name: "group_off",
    cooldownExempt: true,
    allowWhenGroupDisabled: true,
    parse(message) {
      const parts = splitParts(message);
      if (parts[0] !== "/group" || parts[1] !== "off" || parts.length < 2) {
        return null;
      }
      const rawGroupId = parts[2];
      if (!rawGroupId) return { groupId: undefined };
      const groupId = parseNumber(rawGroupId);
      if (groupId === null) return null;
      return { groupId };
    },
    async execute(context, payload) {
      const parsed = payload as { groupId?: number };
      const targetGroupId =
        typeof parsed.groupId === "number" ? parsed.groupId : context.groupId;
      if (typeof targetGroupId !== "number") {
        await context.sendText("请在群内使用或提供群号");
        return;
      }
      configStore.setGroupEnabled(targetGroupId, false);
      await context.sendText(`已关闭群 ${targetGroupId}`);
    },
  }),
  defineCommand({
    name: "cooldown_get",
    parse(message) {
      const parts = splitParts(message);
      if (parts[0] === "/cooldown" && parts.length === 1) return emptyPayload;
      return null;
    },
    async execute(context) {
      await context.sendText(`当前冷却时间 ${configStore.getCooldownMs()}ms`);
    },
  }),
  defineCommand({
    name: "cooldown_set",
    cooldownExempt: true,
    parse(message) {
      const parts = splitParts(message);
      if (parts[0] !== "/cooldown" || parts.length === 1) return null;
      const ms = parseNumber(parts[1], true);
      if (ms === null) return null;
      return { ms };
    },
    async execute(context, payload) {
      const ms = (payload as { ms: number }).ms;
      configStore.setCooldownMs(ms);
      await context.sendText(`已设置冷却时间 ${ms}ms`);
    },
  }),
];

const commandRegistry: CommandDefinition<unknown>[] = [...builtInCommands];

export function registerCommand(definition: CommandDefinition<unknown>): void {
  commandRegistry.push(definition);
}

export function getCommandRegistry(): readonly CommandDefinition<unknown>[] {
  return commandRegistry;
}

export function parseCommand(message: string): ParsedCommand | null {
  for (const definition of commandRegistry) {
    const payload = definition.parse(message);
    if (payload === null) continue;
    return { definition, payload };
  }
  return null;
}
