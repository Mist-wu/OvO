import { config } from "../config";
import type { ChatEvent } from "./types";

export type ChatConversationMessage = {
  role: "user" | "assistant";
  text: string;
  userId?: number;
  senderName?: string;
  messageId?: number | string;
  timestampMs: number;
};

type ChatSessionKey = string;

type ChatSessionStoreOptions = {
  expireWindowMs?: number;
  maxTurns?: number;
};

type ChatSessionLocator = Pick<ChatEvent, "scope" | "userId" | "groupId" | "eventTimeMs">;

function resolveEventTimeMs(event: ChatSessionLocator): number {
  if (typeof event.eventTimeMs === "number" && Number.isFinite(event.eventTimeMs) && event.eventTimeMs > 0) {
    return Math.floor(event.eventTimeMs);
  }
  return Date.now();
}

function normalizeMaxTurns(value: number | undefined): number {
  if (!Number.isFinite(value) || !value) return 30;
  return Math.max(1, Math.floor(value));
}

function normalizeExpireWindowMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined) return 2 * 60 * 1000;
  return Math.max(0, Math.floor(value));
}

function buildSessionKey(event: Pick<ChatEvent, "scope" | "userId" | "groupId">): ChatSessionKey | null {
  if (event.scope === "group") {
    if (typeof event.groupId !== "number" || !Number.isFinite(event.groupId) || event.groupId <= 0) {
      return null;
    }
    return `group:${event.groupId}`;
  }

  if (!Number.isFinite(event.userId) || event.userId <= 0) {
    return null;
  }
  return `private:${event.userId}`;
}

export class ChatSessionStore {
  private readonly sessions = new Map<ChatSessionKey, ChatConversationMessage[]>();
  private readonly expireWindowMs: number;
  private readonly maxMessages: number;

  constructor(options?: ChatSessionStoreOptions) {
    this.expireWindowMs = normalizeExpireWindowMs(options?.expireWindowMs);
    this.maxMessages = Math.max(2, normalizeMaxTurns(options?.maxTurns) * 2);
  }

  getRecentMessages(event: ChatSessionLocator): ChatConversationMessage[] {
    const key = buildSessionKey(event);
    if (!key) return [];

    const messages = this.pruneAndGetMessages(key, resolveEventTimeMs(event));
    return messages.map((message) => ({ ...message }));
  }

  appendUserMessage(event: ChatEvent): void {
    const key = buildSessionKey(event);
    const text = event.text.trim();
    if (!key || !text) {
      return;
    }

    const nowMs = resolveEventTimeMs(event);
    const messages = this.pruneAndGetMessages(key, nowMs);
    const messageId = event.messageId;
    const latest = messages[messages.length - 1];
    if (latest?.role === "user" && messageId !== undefined && latest.messageId === messageId) {
      return;
    }

    messages.push({
      role: "user",
      text,
      userId: event.userId,
      senderName: event.senderName,
      messageId,
      timestampMs: nowMs,
    });

    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }

    this.sessions.set(key, messages);
  }

  appendAssistantMessage(event: ChatEvent, assistantText: string): void {
    const key = buildSessionKey(event);
    const text = assistantText.trim();
    if (!key || !text) {
      return;
    }

    const nowMs = resolveEventTimeMs(event);
    const messages = this.pruneAndGetMessages(key, nowMs);
    messages.push({
      role: "assistant",
      text,
      userId: event.selfId,
      senderName: "OvO",
      timestampMs: nowMs,
    });

    if (messages.length > this.maxMessages) {
      messages.splice(0, messages.length - this.maxMessages);
    }

    this.sessions.set(key, messages);
  }

  reset(): void {
    this.sessions.clear();
  }

  private pruneAndGetMessages(key: ChatSessionKey, nowMs: number): ChatConversationMessage[] {
    const existing = this.sessions.get(key);
    if (!existing || existing.length <= 0) {
      return [];
    }

    if (this.expireWindowMs <= 0) {
      this.sessions.delete(key);
      return [];
    }

    const latest = existing[existing.length - 1];
    if (!latest || nowMs - latest.timestampMs > this.expireWindowMs) {
      this.sessions.delete(key);
      return [];
    }

    const kept = existing.filter((turn) => nowMs - turn.timestampMs <= this.expireWindowMs);
    if (kept.length <= 0) {
      this.sessions.delete(key);
      return [];
    }

    if (kept.length !== existing.length) {
      this.sessions.set(key, kept);
    }
    return kept;
  }
}

export const chatSessionStore = new ChatSessionStore({
  expireWindowMs: config.chat.contextWindowMs,
  maxTurns: config.chat.contextMaxTurns,
});
