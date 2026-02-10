import { config } from "../config";
import { chatOrchestrator } from "../chat";
import { createSessionKey } from "../chat/session_store";
import type { ChatEvent, TriggerDecision } from "../chat/types";
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

type PendingChatDispatch = {
  seq: number;
  timer: NodeJS.Timeout;
  client: NapcatClient;
  event: ChatEvent;
  decision: TriggerDecision;
};

const pendingChatDispatches = new Map<string, PendingChatDispatch>();
let pendingChatSeq = 0;

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

  console.debug("[event] 未识别 post_type:", event.post_type);
}

async function handleMessage(client: NapcatClient, event: MessageEvent): Promise<void> {
  if (typeof event.user_id === "number" && event.user_id === event.self_id) {
    return;
  }

  const userId = event.user_id;
  const groupId = event.group_id;
  const messageType = event.message_type;
  const chatQueueKey = createChatQueueKey(event);

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

  clearPendingChatDispatch(chatQueueKey);

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

  const chatEvent = toChatEvent(event, message);
  const chatQueueKey = createSessionKey(chatEvent);
  clearPendingChatDispatch(chatQueueKey);

  const decision = chatOrchestrator.decide(chatEvent);
  if (!decision.shouldReply) return;

  if (decision.waitMs > 0 && decision.priority !== "must") {
    scheduleChatDispatch(chatQueueKey, {
      client,
      event: chatEvent,
      decision,
    });
    return;
  }

  await dispatchChatReply(client, chatEvent, decision);
}

async function handleNotice(client: NapcatClient, event: NoticeEvent): Promise<void> {
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

async function handleRequest(client: NapcatClient, event: RequestEvent): Promise<void> {
  const { request_type, sub_type, user_id, group_id, flag } = event;
  if (!request_type) return;
  console.info("[request]", request_type, sub_type, {
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
    console.debug("[meta] heartbeat");
    return;
  }
  console.debug("[meta]", event.meta_event_type);
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

function toChatEvent(event: MessageEvent, message: string): ChatEvent {
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
  };
}

async function dispatchChatReply(
  client: NapcatClient,
  event: ChatEvent,
  decision: TriggerDecision,
): Promise<void> {
  const reply = await chatOrchestrator.handle(event, decision);
  if (!reply) return;

  if (event.scope === "group" && typeof event.groupId === "number") {
    await client.sendGroupText(event.groupId, reply.text);
    return;
  }

  await client.sendPrivateText(event.userId, reply.text);
}

function scheduleChatDispatch(
  queueKey: string,
  pending: Omit<PendingChatDispatch, "seq" | "timer">,
): void {
  const seq = ++pendingChatSeq;
  const waitMs = Math.max(0, Math.floor(pending.decision.waitMs));
  const timer = setTimeout(() => {
    void runScheduledChatDispatch(queueKey, seq);
  }, waitMs);

  pendingChatDispatches.set(queueKey, {
    ...pending,
    seq,
    timer,
  });
}

async function runScheduledChatDispatch(queueKey: string, seq: number): Promise<void> {
  const pending = pendingChatDispatches.get(queueKey);
  if (!pending || pending.seq !== seq) return;

  pendingChatDispatches.delete(queueKey);
  try {
    await dispatchChatReply(pending.client, pending.event, pending.decision);
  } catch (error) {
    console.warn("[chat] delayed dispatch failed:", error);
  }
}

function clearPendingChatDispatch(queueKey: string): void {
  const pending = pendingChatDispatches.get(queueKey);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingChatDispatches.delete(queueKey);
}

function createChatQueueKey(event: MessageEvent): string {
  const userId = event.user_id;
  if (typeof userId !== "number") return "";
  if (event.message_type === "group" && typeof event.group_id === "number") {
    return `g:${event.group_id}:u:${userId}`;
  }
  return `p:${userId}`;
}
