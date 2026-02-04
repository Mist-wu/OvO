import { config } from "../config";
import type { NapcatClient } from "./client";

type MessageSegment = {
  type?: string;
  data?: Record<string, unknown>;
};

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
  | { name: "help" };

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

  const message = getMessageText(event);
  if (!message) {
    return;
  }

  const command = parseCommand(message);
  if (!command) {
    return;
  }

  if (event.message_type === "private" && typeof event.user_id === "number") {
    await replyPrivate(client, event.user_id, command);
    return;
  }

  if (event.message_type === "group" && typeof event.group_id === "number") {
    await replyGroup(client, event.group_id, command);
  }
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
  return null;
}

async function replyPrivate(client: NapcatClient, userId: number, command: Command): Promise<void> {
  switch (command.name) {
    case "ping":
      await client.sendPrivateText(userId, "pong");
      return;
    case "echo":
      await client.sendPrivateText(userId, command.text || "(empty)");
      return;
    case "help":
      await client.sendPrivateText(userId, "/ping /echo <text> /help");
  }
}

async function replyGroup(client: NapcatClient, groupId: number, command: Command): Promise<void> {
  switch (command.name) {
    case "ping":
      await client.sendGroupText(groupId, "pong");
      return;
    case "echo":
      await client.sendGroupText(groupId, command.text || "(empty)");
      return;
    case "help":
      await client.sendGroupText(groupId, "/ping /echo <text> /help");
  }
}
