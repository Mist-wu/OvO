import { config } from "../config";
import type { NapcatClient } from "./client";
import { defaultCommandMiddlewares, runMiddlewares } from "./commands/middleware";
import { parseCommand } from "./commands/registry";
import type { CommandExecutionContext, OneBotEvent } from "./commands/types";
import type { MessageSegment } from "./message";

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

  const isRoot = typeof config.permissions.rootUserId === "number" && userId === config.permissions.rootUserId;
  const executionContext: CommandExecutionContext = {
    client,
    event,
    userId,
    groupId,
    messageType,
    isRoot,
    sendText: (text) => sendContextText(client, event, text),
  };

  await runMiddlewares(
    { ...executionContext, command },
    defaultCommandMiddlewares,
    async () => {
      await command.definition.execute(executionContext, command.payload);
    },
  );
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
