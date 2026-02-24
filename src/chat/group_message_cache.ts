import type { ChatEvent, SessionMessage } from "./types";

type CachedGroupMessage = {
  groupId: number;
  userId: number;
  speakerName?: string;
  messageId?: number | string;
  text: string;
  ts: number;
};

type GroupMessageCacheOptions = {
  maxGroups: number;
  maxMessagesPerGroup: number;
  ttlMs: number;
};

const DEFAULT_OPTIONS: GroupMessageCacheOptions = {
  maxGroups: 200,
  maxMessagesPerGroup: 120,
  ttlMs: 2 * 60 * 60 * 1000,
};

function normalizeTs(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function fallbackFingerprint(input: {
  userId?: number;
  speakerName?: string;
  text: string;
}): string {
  return `${input.userId ?? -1}|${(input.speakerName ?? "").trim()}|${normalizeText(input.text)}`;
}

export class GroupMessageCache {
  private readonly groups = new Map<number, CachedGroupMessage[]>();

  constructor(private readonly options: Partial<GroupMessageCacheOptions> = {}) {}

  recordIncoming(event: ChatEvent): void {
    if (event.scope !== "group" || typeof event.groupId !== "number") return;
    if (typeof event.selfId === "number" && event.userId === event.selfId) return;

    const text = normalizeText(event.text);
    if (!text) return;

    const groupId = event.groupId;
    const ts = normalizeTs(event.eventTimeMs);
    const maxMessagesPerGroup = Math.max(10, this.options.maxMessagesPerGroup ?? DEFAULT_OPTIONS.maxMessagesPerGroup);
    const ttlMs = Math.max(60_000, this.options.ttlMs ?? DEFAULT_OPTIONS.ttlMs);
    const maxGroups = Math.max(10, this.options.maxGroups ?? DEFAULT_OPTIONS.maxGroups);

    const current = (this.groups.get(groupId) ?? []).filter((item) => ts - item.ts <= ttlMs);
    const incomingMessageId = event.messageId;
    if (
      incomingMessageId !== undefined &&
      current.some((item) => item.messageId !== undefined && String(item.messageId) === String(incomingMessageId))
    ) {
      this.groups.set(groupId, current);
      return;
    }

    current.push({
      groupId,
      userId: event.userId,
      speakerName: event.senderName?.trim() || `用户${event.userId}`,
      messageId: incomingMessageId,
      text,
      ts,
    });

    const next =
      current.length > maxMessagesPerGroup ? current.slice(current.length - maxMessagesPerGroup) : current;
    this.groups.set(groupId, next);
    this.pruneGroups(maxGroups);
  }

  getContextMessagesForReply(
    event: ChatEvent,
    existingHistory: SessionMessage[],
    options?: { limit?: number },
  ): SessionMessage[] {
    if (event.scope !== "group" || typeof event.groupId !== "number") return [];
    const items = this.groups.get(event.groupId) ?? [];
    if (items.length <= 0) return [];

    const limit = Math.max(0, Math.floor(options?.limit ?? 10));
    if (limit <= 0) return [];

    const seenMessageIds = new Set<string>();
    const seenFallbackKeys = new Set<string>();
    for (const item of existingHistory) {
      if (item.sourceMessageId !== undefined) {
        seenMessageIds.add(String(item.sourceMessageId));
      } else if (item.role === "user") {
        seenFallbackKeys.add(
          fallbackFingerprint({
            speakerName: item.speakerName,
            text: item.text,
          }),
        );
      }
    }

    const currentMessageId = event.messageId !== undefined ? String(event.messageId) : undefined;
    const currentFallbackKey = fallbackFingerprint({
      userId: event.userId,
      speakerName: event.senderName?.trim() || `用户${event.userId}`,
      text: event.text,
    });

    const selected: SessionMessage[] = [];
    for (let index = items.length - 1; index >= 0; index -= 1) {
      const item = items[index];
      if (!item) continue;

      if (item.messageId !== undefined) {
        const id = String(item.messageId);
        if (currentMessageId && id === currentMessageId) continue;
        if (seenMessageIds.has(id)) continue;
      } else {
        const key = fallbackFingerprint(item);
        if (key === currentFallbackKey) continue;
        if (seenFallbackKeys.has(key)) continue;
      }

      selected.push({
        role: "user",
        text: item.text,
        ts: item.ts,
        speakerName: item.speakerName,
        sourceMessageId: item.messageId,
      });
      if (selected.length >= limit) break;
    }

    return selected.reverse();
  }

  private pruneGroups(maxGroups: number): void {
    const overflow = this.groups.size - maxGroups;
    if (overflow <= 0) return;

    const sorted = Array.from(this.groups.entries()).sort((a, b) => {
      const aTs = a[1][a[1].length - 1]?.ts ?? 0;
      const bTs = b[1][b[1].length - 1]?.ts ?? 0;
      return aTs - bTs;
    });

    for (let i = 0; i < overflow; i += 1) {
      const item = sorted[i];
      if (!item) break;
      this.groups.delete(item[0]);
    }
  }
}

export const groupMessageCache = new GroupMessageCache();

