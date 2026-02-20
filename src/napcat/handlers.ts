import { logger } from "../utils/logger";
import { config } from "../config";
import { chatAgentLoop } from "../chat";
import type { ChatEvent, ChatQuotedMessage } from "../chat/types";
import type { NapcatClient } from "./client";
import { defaultCommandMiddlewares, runMiddlewares } from "./commands/middleware";
import { parseCommand } from "./commands/registry";
import {
  isMessageEvent,
  isMetaEvent,
  isNoticeEvent,
  isRequestEvent,
  type CommandExecutionContext,
  type MessageEvent,
  type MetaEvent,
  type NoticeEvent,
  type OneBotEvent,
  type RequestEvent,
} from "./commands/types";
import type { MessageSegment } from "./message";

export async function handleEvent(client: NapcatClient, event: OneBotEvent): Promise<void> {
  if (isMessageEvent(event)) {
    await handleMessage(client, event);
    return;
  }

  if (isNoticeEvent(event)) {
    await handleNotice(client, event);
    return;
  }

  if (isRequestEvent(event)) {
    await handleRequest(client, event);
    return;
  }

  if (isMetaEvent(event)) {
    handleMeta(event);
    return;
  }

  logger.debug("[event] 未识别 post_type:", event.post_type);
}

async function handleMessage(client: NapcatClient, event: MessageEvent): Promise<void> {
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
    await handleChatMessage(client, event, "");
    return;
  }

  const command = parseCommand(message);
  if (!command) {
    await handleChatMessage(client, event, message);
    return;
  }

  const isRoot =
    typeof config.permissions.rootUserId === "number" && userId === config.permissions.rootUserId;
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

async function handleChatMessage(client: NapcatClient, event: MessageEvent, message: string): Promise<void> {
  const userId = event.user_id;
  if (typeof userId !== "number") return;

  const quotedMessage = await resolveQuotedMessage(client, event);
  const chatEvent = toChatEvent(event, message, quotedMessage);
  await chatAgentLoop.onIncomingMessage(client, chatEvent);
}

async function handleNotice(client: NapcatClient, event: NoticeEvent): Promise<void> {
  const { notice_type, sub_type, group_id, user_id } = event;
  if (!notice_type) return;
  logger.info("[notice]", notice_type, sub_type, {
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

async function handleRequest(client: NapcatClient, event: RequestEvent): Promise<void> {
  const { request_type, sub_type, user_id, group_id, flag } = event;
  if (!request_type) return;
  logger.info("[request]", request_type, sub_type, {
    user_id,
    group_id,
  });

  if (request_type === "group" && config.requests.autoApproveGroup && flag) {
    await client.approveGroupRequest(flag, sub_type);
  }

  if (request_type === "friend" && config.requests.autoApproveFriend && flag) {
    await client.approveFriendRequest(flag);
  }
}

function handleMeta(event: MetaEvent): void {
  if (event.meta_event_type === "heartbeat") {
    logger.debug("[meta] heartbeat");
    return;
  }
  logger.debug("[meta]", event.meta_event_type);
}

function getMessageText(event: MessageEvent): string {
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

type GetMsgData = {
  message?: unknown;
  raw_message?: unknown;
  sender?: unknown;
  user_id?: unknown;
};

function getReplySegmentId(segments: MessageSegment[] | undefined): number | string | undefined {
  if (!Array.isArray(segments)) return undefined;

  for (const segment of segments) {
    if (segment.type !== "reply") continue;
    const id = segment.data?.id;
    if (typeof id === "number" || typeof id === "string") {
      return id;
    }
  }

  return undefined;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function parseCqParams(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (!key) continue;
    result[key.trim()] = rest.join("=").trim();
  }
  return result;
}

function parseRawCqMessage(raw: string): { summary: string; segments: MessageSegment[] } {
  const regex = /\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]+))?\]/g;
  const summaryParts: string[] = [];
  const segments: MessageSegment[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    const normalized = normalizeWhitespace(text);
    if (normalized) summaryParts.push(normalized);
  };

  for (const match of raw.matchAll(regex)) {
    const full = match[0] ?? "";
    const type = (match[1] ?? "").toLowerCase();
    const params = parseCqParams(match[2]);
    const index = match.index ?? 0;

    if (index > cursor) {
      pushText(raw.slice(cursor, index));
    }

    switch (type) {
      case "image": {
        const imageRef = params.url || params.file || params.path;
        if (imageRef) {
          segments.push({
            type: "image",
            data: {
              url: params.url ?? "",
              file: params.file ?? imageRef,
              path: params.path ?? "",
            },
          });
        }
        summaryParts.push("[图片]");
        break;
      }
      case "face":
      case "mface":
        summaryParts.push("[表情]");
        break;
      case "at":
        summaryParts.push(params.qq ? `@${params.qq}` : "@用户");
        break;
      case "reply":
        break;
      default:
        summaryParts.push(`[${type}]`);
        break;
    }

    cursor = index + full.length;
  }

  if (cursor < raw.length) {
    pushText(raw.slice(cursor));
  }

  return {
    summary: normalizeWhitespace(summaryParts.join(" ")),
    segments,
  };
}

function summarizeQuotedSegments(segments: MessageSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.type === "text") {
      const text = segment.data?.text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
      continue;
    }

    if (segment.type === "image") {
      parts.push("[图片]");
      continue;
    }

    if (segment.type === "face" || segment.type === "mface") {
      parts.push("[表情]");
      continue;
    }

    if (segment.type === "at") {
      const qq = segment.data?.qq;
      parts.push(
        typeof qq === "number" || typeof qq === "string" ? `@${String(qq)}` : "@用户",
      );
      continue;
    }

    if (segment.type === "reply") {
      continue;
    }

    parts.push(`[${segment.type}]`);
  }
  return normalizeWhitespace(parts.join(" "));
}

function extractSegmentsFromUnknownMessage(message: unknown): MessageSegment[] {
  if (Array.isArray(message)) {
    return message as MessageSegment[];
  }

  if (message && typeof message === "object" && "type" in message && "data" in message) {
    return [message as MessageSegment];
  }

  if (typeof message === "string") {
    return parseRawCqMessage(message).segments;
  }

  return [];
}

function getSenderNameFromUnknown(sender: unknown): string | undefined {
  if (!sender || typeof sender !== "object") return undefined;

  const parsed = sender as { card?: unknown; nickname?: unknown };
  if (typeof parsed.card === "string" && parsed.card.trim()) {
    return parsed.card.trim();
  }
  if (typeof parsed.nickname === "string" && parsed.nickname.trim()) {
    return parsed.nickname.trim();
  }

  return undefined;
}

async function resolveQuotedMessage(
  client: NapcatClient,
  event: MessageEvent,
): Promise<ChatQuotedMessage | undefined> {
  const segments = Array.isArray(event.message) ? event.message : undefined;
  const replyMessageId = getReplySegmentId(segments);
  if (replyMessageId === undefined) return undefined;

  try {
    const response = await client.getMsg(replyMessageId);
    const data = response.data as GetMsgData | undefined;
    const senderName = getSenderNameFromUnknown(data?.sender);

    const messageRawString = typeof data?.message === "string" ? data.message.trim() : "";
    const parsedMessageString = messageRawString ? parseRawCqMessage(messageRawString) : undefined;

    const rawMessage = typeof data?.raw_message === "string" ? data.raw_message.trim() : "";
    const parsedRawMessage = rawMessage ? parseRawCqMessage(rawMessage) : undefined;

    let quotedSegments = extractSegmentsFromUnknownMessage(data?.message);
    if (quotedSegments.length <= 0 && parsedRawMessage && parsedRawMessage.segments.length > 0) {
      quotedSegments = parsedRawMessage.segments;
    }

    const summaryFromSegments = summarizeQuotedSegments(quotedSegments);
    const text =
      summaryFromSegments ||
      parsedMessageString?.summary ||
      parsedRawMessage?.summary ||
      "(引用消息为非文本内容)";

    return {
      messageId: replyMessageId,
      text,
      senderName,
      rawMessage: rawMessage || undefined,
      segments: quotedSegments.length > 0 ? quotedSegments : undefined,
      userId:
        typeof data?.user_id === "number" || typeof data?.user_id === "string"
          ? data.user_id
          : undefined,
    };
  } catch (error) {
    logger.warn(`[chat] 获取引用消息失败 message_id=${String(replyMessageId)}`, error);
    return {
      messageId: replyMessageId,
      text: "(引用消息读取失败)",
    };
  }
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
  event: MessageEvent,
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

function getSenderName(event: MessageEvent): string | undefined {
  const sender = (event as { sender?: unknown }).sender;
  return getSenderNameFromUnknown(sender);
}

function toChatEvent(
  event: MessageEvent,
  message: string,
  quotedMessage?: ChatQuotedMessage,
): ChatEvent {
  const groupId = typeof event.group_id === "number" ? event.group_id : undefined;
  const scope = event.message_type === "group" ? "group" : "private";
  const segments = Array.isArray(event.message) ? event.message : undefined;
  const messageId =
    typeof event.message_id === "number" || typeof event.message_id === "string"
      ? event.message_id
      : undefined;
  const eventTimeMs =
    typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0
      ? Math.floor(event.time * 1000)
      : Date.now();

  return {
    scope,
    userId: event.user_id as number,
    senderName: getSenderName(event),
    groupId,
    selfId: typeof event.self_id === "number" ? event.self_id : undefined,
    messageId,
    eventTimeMs,
    text: message,
    rawMessage: typeof event.raw_message === "string" ? event.raw_message : undefined,
    segments,
    quotedMessage,
  };
}
