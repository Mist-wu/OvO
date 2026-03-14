import { logger } from "../utils/logger";
import { config } from "../config";
import { activityStore } from "../activity/store";
import { chatOrchestrator } from "../chat";
import { chatSessionStore } from "../chat/session";
import { configStore } from "../storage/config_store";
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
import { buildMessage, reply as replySegment, text as textSegment, type MessageSegment } from "./message";
import {
  extractSegmentsFromUnknownMessage,
  getForwardSegmentId,
  getReplySegmentId,
  getSenderNameFromUnknown,
  parseRawCqMessage,
  summarizeMessageSegments,
} from "./message_utils";

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

  activityStore.recordMessage({
    scope: event.message_type === "group" ? "group" : "private",
    groupId: typeof groupId === "number" ? groupId : undefined,
    userId,
    userName: getSenderName(event),
    eventTimeMs:
      typeof event.time === "number" && Number.isFinite(event.time) && event.time > 0
        ? Math.floor(event.time * 1000)
        : Date.now(),
    segments: Array.isArray(event.message) ? event.message : undefined,
  });

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
  if (event.message_type === "group" && typeof event.group_id === "number") {
    if (!configStore.isGroupChatEnabled(event.group_id)) {
      return;
    }
  }

  const visibleMessage = getChatVisibleText(event) || message;
  const baseChatEvent = toChatEvent(event, visibleMessage);
  const decision = chatOrchestrator.decide(baseChatEvent);
  if (!decision.shouldReply) {
    chatSessionStore.appendUserMessage(baseChatEvent);
    return;
  }

  const quotedMessage = await resolveQuotedMessage(client, event);
  const chatEvent = quotedMessage ? { ...baseChatEvent, quotedMessage } : baseChatEvent;
  const reply = await chatOrchestrator.handle(chatEvent, decision);
  if (!reply || !reply.text.trim()) {
    chatSessionStore.appendUserMessage(chatEvent);
    return;
  }

  await sendChatReply(client, chatEvent, reply.text, reply.quoteMessageId);
  chatSessionStore.appendUserMessage(chatEvent);
  chatSessionStore.appendAssistantMessage(chatEvent, reply.text);
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

function getChatVisibleText(event: MessageEvent): string {
  if (Array.isArray(event.message)) {
    const summary = summarizeMessageSegments(event.message, {
      skipReply: true,
      includeForwardPlaceholder: true,
      selfId: event.self_id,
    });
    if (summary) return summary;
  }
  if (typeof event.raw_message === "string" && event.raw_message.trim()) {
    return parseRawCqMessage(event.raw_message.trim(), { selfId: event.self_id }).summary || event.raw_message.trim();
  }
  if (typeof event.message === "string" && event.message.trim()) {
    return event.message.trim();
  }
  return "";
}

type GetMsgData = {
  message?: unknown;
  raw_message?: unknown;
  sender?: unknown;
  user_id?: unknown;
};

type GetForwardMsgNode = {
  data?: {
    nickname?: unknown;
    name?: unknown;
    content?: unknown;
    message?: unknown;
  };
  nickname?: unknown;
  name?: unknown;
  content?: unknown;
  message?: unknown;
};

type GetForwardMsgData = {
  messages?: unknown;
  message?: unknown;
} | unknown[];

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function extractForwardNodes(data: GetForwardMsgData | undefined): GetForwardMsgNode[] {
  if (Array.isArray(data)) return data as GetForwardMsgNode[];
  if (!data || typeof data !== "object") return [];
  const record = data as { messages?: unknown; message?: unknown };
  if (Array.isArray(record.messages)) return record.messages as GetForwardMsgNode[];
  if (Array.isArray(record.message)) return record.message as GetForwardMsgNode[];
  return [];
}

function summarizeForwardNodes(nodes: GetForwardMsgNode[]): string {
  if (nodes.length <= 0) return "";
  const lines: string[] = [];
  for (const [index, node] of nodes.slice(0, 8).entries()) {
    const source = node.data && typeof node.data === "object" ? node.data : node;
    const sourceRecord = source as Record<string, unknown>;
    const nickname =
      (typeof sourceRecord.nickname === "string" && sourceRecord.nickname.trim()) ||
      (typeof sourceRecord.name === "string" && sourceRecord.name.trim()) ||
      "";
    const contentSummary =
      summarizeMessageSegments(extractSegmentsFromUnknownMessage(sourceRecord.content ?? sourceRecord.message), {
        skipReply: true,
        includeForwardPlaceholder: true,
      }) ||
      (typeof sourceRecord.content === "string" ? normalizeWhitespace(sourceRecord.content) : "");
    lines.push(`${index + 1}. ${nickname || "成员"}: ${contentSummary || "[非文本]"}`);
  }
  return `[聊天记录]\n${lines.join("\n")}`;
}

async function resolveForwardSummary(
  client: NapcatClient,
  quotedSegments: MessageSegment[],
): Promise<string> {
  const forwardId = getForwardSegmentId(quotedSegments);
  if (forwardId === undefined) return "";

  try {
    const response = await client.sendAction("get_forward_msg", { id: forwardId });
    const nodes = extractForwardNodes(response.data as GetForwardMsgData | undefined);
    return summarizeForwardNodes(nodes);
  } catch (error) {
    logger.warn(`[chat] 获取引用聊天记录失败 forward_id=${String(forwardId)}`, error);
    return "";
  }
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

    const summaryFromSegments = summarizeMessageSegments(quotedSegments, {
      skipReply: true,
      includeForwardPlaceholder: true,
    });
    const forwardSummary = await resolveForwardSummary(client, quotedSegments);
    const text =
      [summaryFromSegments, forwardSummary].filter(Boolean).join("\n") ||
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

async function sendChatReply(
  client: NapcatClient,
  event: ChatEvent,
  text: string,
  quoteMessageId?: number | string,
): Promise<void> {
  if (event.scope === "group" && typeof event.groupId === "number") {
    if (quoteMessageId !== undefined) {
      await client.sendMessage({
        groupId: event.groupId,
        message: buildMessage(replySegment(quoteMessageId), textSegment(text)),
      });
      return;
    }
    await client.sendMessage({
      groupId: event.groupId,
      message: text,
    });
    return;
  }
  await client.sendPrivateText(event.userId, text);
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
