import { config } from "../config";
import { configStore } from "../storage/config_store";
import type { NapcatClient } from "./client";
import type { MessageSegment } from "./message";

type OneBotEvent = Record<string, unknown> & {
  post_type?: string;
  message_type?: string;
  notice_type?: string;
  request_type?: string;
  meta_event_type?: string;
  sub_type?: string;
  flag?: string;
  self_id?: number;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
  message?: string | MessageSegment[];
};

type Command =
  | { name: "ping" }
  | { name: "echo"; text: string }
  | { name: "help" }
  | { name: "admin_add"; target: number }
  | { name: "admin_del"; target: number }
  | { name: "whitelist_add"; target: number }
  | { name: "whitelist_del"; target: number }
  | { name: "group_on"; groupId?: number }
  | { name: "group_off"; groupId?: number }
  | { name: "cooldown_set"; ms: number }
  | { name: "cooldown_get" };

const cooldowns = new Map<string, number>();
const helpText =
  "/ping /echo <text> /help " +
  "/admin add|del <qq> /whitelist add|del <qq> " +
  "/group on|off [group_id] /cooldown [ms]";

export async function handleEvent(client: NapcatClient, event: OneBotEvent): Promise<void> {
  switch (event.post_type) {
    case "message":
      await handleMessage(client, event);
      return;
    case "notice":
      await handleNotice(client, event);
      return;
    case "request":
      await handleRequest(client, event);
      return;
    case "meta_event":
      handleMeta(event);
      return;
    default:
      console.debug("[event] 未识别 post_type:", event.post_type);
  }
}

async function handleMessage(client: NapcatClient, event: OneBotEvent): Promise<void> {
  if (typeof event.user_id === "number" && event.user_id === event.self_id) {
    return;
  }

  const userId = event.user_id;
  const groupId = event.group_id;
  const messageType = event.message_type;

  if (typeof userId !== "number") {
    return;
  }

  const message = getMessageText(event);
  if (!message) {
    return;
  }

  const command = parseCommand(message);
  if (!command) {
    return;
  }

  if (
    messageType === "group" &&
    typeof groupId === "number" &&
    !configStore.isGroupEnabled(groupId) &&
    !isGroupToggleCommand(command)
  ) {
    await sendContextText(client, event, "本群已关闭");
    return;
  }

  const isAdmin = configStore.isAdmin(userId);
  if (isAdminCommand(command) && !isAdmin) {
    await sendContextText(client, event, "无权限");
    return;
  }

  if (!isAdmin && configStore.whitelistEnabled() && !configStore.isWhitelisted(userId)) {
    await sendContextText(client, event, "无权限");
    return;
  }

  const cooldownMs = configStore.getCooldownMs();
  if (cooldownMs > 0 && !isAdmin && !isCooldownExempt(command)) {
    const key = getCooldownKey(command, userId, groupId, messageType);
    const now = Date.now();
    const last = cooldowns.get(key) ?? 0;
    const remaining = cooldownMs - (now - last);
    if (remaining > 0) {
      const seconds = Math.ceil(remaining / 1000);
      await sendContextText(client, event, `冷却中，请稍后再试 (${seconds}s)`);
      return;
    }
    cooldowns.set(key, now);
  }

  await dispatchCommand(client, event, command, isAdmin);
}

async function handleNotice(client: NapcatClient, event: OneBotEvent): Promise<void> {
  const { notice_type, sub_type, group_id, user_id } = event;
  if (!notice_type) return;
  console.info("[notice]", notice_type, sub_type, {
    group_id,
    user_id,
  });

  if (
    config.welcome.enabled &&
    notice_type === "group_increase" &&
    typeof group_id === "number" &&
    typeof user_id === "number"
  ) {
    const text = formatTemplate(config.welcome.message, { user_id });
    await client.sendGroupText(group_id, text);
  }

  if (config.pokeReply.enabled && notice_type === "notify" && sub_type === "poke") {
    const text = formatTemplate(config.pokeReply.message, { user_id });
    if (typeof group_id === "number") {
      await client.sendGroupText(group_id, text);
    } else if (typeof user_id === "number") {
      await client.sendPrivateText(user_id, text);
    }
  }
}

async function handleRequest(client: NapcatClient, event: OneBotEvent): Promise<void> {
  const { request_type, sub_type, user_id, group_id, flag } = event;
  if (!request_type) return;
  console.info("[request]", request_type, sub_type, {
    user_id,
    group_id,
  });

  if (request_type === "group" && config.requests.autoApproveGroup && flag) {
    await client.sendAction("set_group_add_request", {
      flag,
      sub_type,
      approve: true,
    });
  }

  if (request_type === "friend" && config.requests.autoApproveFriend && flag) {
    await client.sendAction("set_friend_add_request", {
      flag,
      approve: true,
    });
  }
}

function handleMeta(event: OneBotEvent): void {
  if (event.meta_event_type === "heartbeat") {
    console.debug("[meta] heartbeat");
    return;
  }
  console.debug("[meta]", event.meta_event_type);
}

function getMessageText(event: OneBotEvent): string {
  if (typeof event.message === "string") {
    return event.message.trim();
  }
  if (Array.isArray(event.message)) {
    const text = extractTextFromSegments(event.message);
    if (text) return text;
  }
  if (typeof event.raw_message === "string") {
    return event.raw_message.trim();
  }
  return "";
}

function extractTextFromSegments(segments: MessageSegment[]): string {
  return segments
    .map((segment) => {
      if (segment.type !== "text") return "";
      const text = segment.data?.text;
      return typeof text === "string" ? text : "";
    })
    .join("")
    .trim();
}

function formatTemplate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = data[key];
    if (value === undefined || value === null) return match;
    return String(value);
  });
}

function parseCommand(message: string): Command | null {
  const trimmed = message.trim();
  if (trimmed === "/ping") return { name: "ping" };
  if (trimmed === "/help") return { name: "help" };
  if (trimmed.startsWith("/echo ")) {
    const text = trimmed.slice(6).trim();
    return { name: "echo", text };
  }
  const parts = trimmed.split(/\s+/);
  if (parts[0] === "/admin" && parts.length >= 3) {
    const target = parseNumber(parts[2]);
    if (!target) return null;
    if (parts[1] === "add") return { name: "admin_add", target };
    if (parts[1] === "del") return { name: "admin_del", target };
  }
  if (parts[0] === "/whitelist" && parts.length >= 3) {
    const target = parseNumber(parts[2]);
    if (!target) return null;
    if (parts[1] === "add") return { name: "whitelist_add", target };
    if (parts[1] === "del") return { name: "whitelist_del", target };
  }
  if (parts[0] === "/group" && parts.length >= 2) {
    const groupId = parts[2] ? parseNumber(parts[2]) : undefined;
    if (parts[1] === "on") return { name: "group_on", groupId };
    if (parts[1] === "off") return { name: "group_off", groupId };
  }
  if (parts[0] === "/cooldown") {
    if (parts.length === 1) return { name: "cooldown_get" };
    const ms = parseNumber(parts[1], true);
    if (ms === null) return null;
    return { name: "cooldown_set", ms };
  }
  return null;
}

async function dispatchCommand(
  client: NapcatClient,
  event: OneBotEvent,
  command: Command,
  isAdmin: boolean,
): Promise<void> {
  switch (command.name) {
    case "ping":
      await sendContextText(client, event, "pong");
      return;
    case "echo":
      await sendContextText(client, event, command.text || "(empty)");
      return;
    case "help":
      await sendContextText(client, event, helpText);
      return;
    case "admin_add": {
      const added = configStore.addAdmin(command.target);
      await sendContextText(
        client,
        event,
        added ? `已添加管理员 ${command.target}` : `管理员已存在 ${command.target}`,
      );
      return;
    }
    case "admin_del": {
      const removed = configStore.removeAdmin(command.target);
      await sendContextText(
        client,
        event,
        removed ? `已移除管理员 ${command.target}` : `管理员不存在 ${command.target}`,
      );
      return;
    }
    case "whitelist_add": {
      const added = configStore.addWhitelist(command.target);
      await sendContextText(
        client,
        event,
        added ? `已添加白名单 ${command.target}` : `白名单已存在 ${command.target}`,
      );
      return;
    }
    case "whitelist_del": {
      const removed = configStore.removeWhitelist(command.target);
      await sendContextText(
        client,
        event,
        removed ? `已移除白名单 ${command.target}` : `白名单不存在 ${command.target}`,
      );
      return;
    }
    case "group_on":
    case "group_off": {
      const enabled = command.name === "group_on";
      const targetGroupId =
        typeof command.groupId === "number" ? command.groupId : event.group_id;
      if (typeof targetGroupId !== "number") {
        await sendContextText(client, event, "请在群内使用或提供群号");
        return;
      }
      if (!isAdmin) {
        await sendContextText(client, event, "无权限");
        return;
      }
      configStore.setGroupEnabled(targetGroupId, enabled);
      await sendContextText(
        client,
        event,
        enabled ? `已开启群 ${targetGroupId}` : `已关闭群 ${targetGroupId}`,
      );
      return;
    }
    case "cooldown_get":
      await sendContextText(client, event, `当前冷却时间 ${configStore.getCooldownMs()}ms`);
      return;
    case "cooldown_set":
      if (!isAdmin) {
        await sendContextText(client, event, "无权限");
        return;
      }
      configStore.setCooldownMs(command.ms);
      await sendContextText(client, event, `已设置冷却时间 ${command.ms}ms`);
      return;
  }
}

async function sendContextText(
  client: NapcatClient,
  event: OneBotEvent,
  text: string,
): Promise<void> {
  if (event.message_type === "private" && typeof event.user_id === "number") {
    await client.sendPrivateText(event.user_id, text);
    return;
  }
  if (event.message_type === "group" && typeof event.group_id === "number") {
    await client.sendGroupText(event.group_id, text);
  }
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

function isAdminCommand(command: Command): boolean {
  return (
    command.name === "admin_add" ||
    command.name === "admin_del" ||
    command.name === "whitelist_add" ||
    command.name === "whitelist_del" ||
    command.name === "group_on" ||
    command.name === "group_off" ||
    command.name === "cooldown_set"
  );
}

function isGroupToggleCommand(command: Command): boolean {
  return command.name === "group_on" || command.name === "group_off";
}

function isCooldownExempt(command: Command): boolean {
  return command.name === "help" || isAdminCommand(command);
}

function getCooldownKey(
  command: Command,
  userId: number,
  groupId: number | undefined,
  messageType: string | undefined,
): string {
  if (messageType === "group" && typeof groupId === "number") {
    return `g:${groupId}:${userId}:${command.name}`;
  }
  return `p:${userId}:${command.name}`;
}
