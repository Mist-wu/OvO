import { config } from "../config";
import type { ChatEvent } from "./types";

export type ChatConversationTurn = {
  userText: string;
  userId: number;
  senderName?: string;
  assistantText: string;
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
  private readonly sessions = new Map<ChatSessionKey, ChatConversationTurn[]>();
  private readonly expireWindowMs: number;
  private readonly maxTurns: number;

  constructor(options?: ChatSessionStoreOptions) {
    this.expireWindowMs = normalizeExpireWindowMs(options?.expireWindowMs);
    this.maxTurns = normalizeMaxTurns(options?.maxTurns);
  }

  getRecentTurns(event: ChatSessionLocator): ChatConversationTurn[] {
    const key = buildSessionKey(event);
    if (!key) return [];

    const turns = this.pruneAndGetTurns(key, resolveEventTimeMs(event));
    return turns.map((turn) => ({ ...turn }));
  }

  appendTurn(event: ChatEvent, assistantText: string): void {
    const key = buildSessionKey(event);
    const userText = event.text.trim();
    const normalizedAssistantText = assistantText.trim();
    if (!key || !userText || !normalizedAssistantText) {
      return;
    }

    const nowMs = resolveEventTimeMs(event);
    const turns = this.pruneAndGetTurns(key, nowMs);
    turns.push({
      userText,
      userId: event.userId,
      senderName: event.senderName,
      assistantText: normalizedAssistantText,
      timestampMs: nowMs,
    });

    if (turns.length > this.maxTurns) {
      turns.splice(0, turns.length - this.maxTurns);
    }

    this.sessions.set(key, turns);
  }

  reset(): void {
    this.sessions.clear();
  }

  private pruneAndGetTurns(key: ChatSessionKey, nowMs: number): ChatConversationTurn[] {
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
