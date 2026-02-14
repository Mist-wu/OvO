import { config } from "../config";
import { clamp, normalizePositiveInt, normalizeText } from "../utils/helpers";
import { createSessionKey } from "./session_store";
import {
  EMOTION_RULES,
  EMOTION_THRESHOLDS,
  STOP_WORDS,
  type EmotionLabel,
} from "./emotion_dict";
import type { ChatEvent } from "./types";

export type { EmotionLabel };

export type PromptStateContext = {
  emotionLabel: EmotionLabel;
  emotionScore: number;
  userProfileText: string;
  relationshipText: string;
  groupTopicText: string;
  groupActivityText: string;
};

export type TriggerRuntimeHints = {
  userAffinityBoost: number;
  topicRelevanceBoost: number;
  groupHeatBoost: number;
};

export type GroupStateSnapshot = {
  groupId: number;
  topic: string;
  topicKeywords: string[];
  messageCountRecent: number;
  participantCountRecent: number;
  lastMessageAt: number;
  lastProactiveAt: number;
};

export type ChatStateEngineRuntimeStats = {
  users: number;
  groups: number;
  sessions: number;
  lastPruneAt: number;
};

type ChatStateEngineOptions = {
  userTtlMs: number;
  groupTtlMs: number;
  sessionTtlMs: number;
  userMax: number;
  groupMax: number;
  sessionMax: number;
  pruneIntervalMs: number;
};

type UserLiveState = {
  userId: number;
  displayName?: string;
  totalMessages: number;
  repliedMessages: number;
  emotionLabel: EmotionLabel;
  emotionScore: number;
  lastSeenAt: number;
  keywordWeights: Map<string, number>;
};

type GroupMessageSample = {
  userId: number;
  text: string;
  ts: number;
  keywords: string[];
};

type GroupLiveState = {
  groupId: number;
  lastMessageAt: number;
  totalMessages: number;
  recentMessages: GroupMessageSample[];
  topic: string;
  topicKeywords: string[];
  lastProactiveAt: number;
};

type SessionLiveState = {
  sessionKey: string;
  lastUpdatedAt: number;
  turns: number;
  lastUserText: string;
  lastReplyText: string;
};

const RECENT_WINDOW_MS = 10 * 60 * 1000;
const MAX_GROUP_SAMPLES = 80;
const MAX_USER_KEYWORDS = 40;

const DEFAULT_ENGINE_OPTIONS: ChatStateEngineOptions = {
  userTtlMs: config.chat.stateUserTtlMs,
  groupTtlMs: config.chat.stateGroupTtlMs,
  sessionTtlMs: config.chat.stateSessionTtlMs,
  userMax: config.chat.stateUserMax,
  groupMax: config.chat.stateGroupMax,
  sessionMax: config.chat.stateSessionMax,
  pruneIntervalMs: config.chat.statePruneIntervalMs,
};



function toRecentWindow(messages: GroupMessageSample[], now: number): GroupMessageSample[] {
  return messages.filter((item) => now - item.ts <= RECENT_WINDOW_MS);
}

function tokenizeTopic(text: string): string[] {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return [];

  const english = normalized.match(/[a-z]{3,}/g) ?? [];
  const chinese = normalized.match(/[\u4e00-\u9fa5]{2,6}/g) ?? [];
  const merged = [...english, ...chinese]
    .map((item) => item.trim())
    .filter((item) => item.length >= 2 && !STOP_WORDS.has(item));

  return Array.from(new Set(merged));
}

function inferEmotion(text: string): { label: EmotionLabel; score: number } {
  const normalized = normalizeText(text);
  if (!normalized) {
    return { label: "neutral", score: 0 };
  }

  let score = 0;
  for (const rule of EMOTION_RULES) {
    if (rule.keywords.some((kw) => normalized.includes(kw))) {
      score += rule.delta;
    }
  }

  const clipped = clamp(score, -1, 1);
  if (clipped >= EMOTION_THRESHOLDS.positiveMin) return { label: "positive", score: clipped };
  if (clipped >= EMOTION_THRESHOLDS.excitedMin) return { label: "excited", score: clipped };
  if (clipped <= EMOTION_THRESHOLDS.negativeMax) return { label: "negative", score: clipped };
  if (/[?？]/.test(normalized)) return { label: "curious", score: Math.max(0.08, clipped) };
  return { label: "neutral", score: clipped };
}

function mergeEmotion(previous: UserLiveState | undefined, next: { label: EmotionLabel; score: number }) {
  if (!previous) {
    return next;
  }
  const mixed = previous.emotionScore * 0.68 + next.score * 0.32;
  const clipped = clamp(mixed, -1, 1);
  const byScore: EmotionLabel =
    clipped >= EMOTION_THRESHOLDS.positiveMin
      ? "positive"
      : clipped >= EMOTION_THRESHOLDS.excitedMin
        ? "excited"
        : clipped <= EMOTION_THRESHOLDS.negativeMax
          ? "negative"
          : next.label === "curious" && clipped > EMOTION_THRESHOLDS.curiousMinScore
            ? "curious"
            : "neutral";
  return { label: byScore, score: clipped };
}

function describeAffinity(totalMessages: number, repliedMessages: number): {
  score: number;
  text: string;
} {
  if (totalMessages <= 0) {
    return { score: 0, text: "陌生" };
  }
  const replyRate = repliedMessages / totalMessages;
  const score = clamp((replyRate - 0.35) * 0.55, -0.2, 0.35);
  if (replyRate >= 0.72) return { score, text: "高互动" };
  if (replyRate >= 0.45) return { score, text: "中互动" };
  return { score, text: "低互动" };
}

function buildTopic(recentMessages: GroupMessageSample[]): { topic: string; keywords: string[] } {
  const freq = new Map<string, number>();
  for (const message of recentMessages) {
    for (const keyword of message.keywords) {
      freq.set(keyword, (freq.get(keyword) ?? 0) + 1);
    }
  }

  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([keyword]) => keyword);
  if (sorted.length <= 0) {
    return { topic: "暂无稳定话题", keywords: [] };
  }
  return {
    topic: sorted.join(" / "),
    keywords: sorted,
  };
}

function describeGroupActivity(messageCountRecent: number, participantCountRecent: number): string {
  if (messageCountRecent >= 40 || participantCountRecent >= 8) return "高活跃";
  if (messageCountRecent >= 18 || participantCountRecent >= 4) return "中活跃";
  return "低活跃";
}

export class ChatStateEngine {
  private users = new Map<number, UserLiveState>();
  private groups = new Map<number, GroupLiveState>();
  private sessions = new Map<string, SessionLiveState>();
  private lastPruneAt = 0;
  private readonly options: ChatStateEngineOptions;

  constructor(options?: Partial<ChatStateEngineOptions>) {
    const merged = {
      ...DEFAULT_ENGINE_OPTIONS,
      ...options,
    };
    this.options = {
      userTtlMs: normalizePositiveInt(merged.userTtlMs, DEFAULT_ENGINE_OPTIONS.userTtlMs),
      groupTtlMs: normalizePositiveInt(merged.groupTtlMs, DEFAULT_ENGINE_OPTIONS.groupTtlMs),
      sessionTtlMs: normalizePositiveInt(merged.sessionTtlMs, DEFAULT_ENGINE_OPTIONS.sessionTtlMs),
      userMax: normalizePositiveInt(merged.userMax, DEFAULT_ENGINE_OPTIONS.userMax),
      groupMax: normalizePositiveInt(merged.groupMax, DEFAULT_ENGINE_OPTIONS.groupMax),
      sessionMax: normalizePositiveInt(merged.sessionMax, DEFAULT_ENGINE_OPTIONS.sessionMax),
      pruneIntervalMs: normalizePositiveInt(
        merged.pruneIntervalMs,
        DEFAULT_ENGINE_OPTIONS.pruneIntervalMs,
      ),
    };
  }

  recordIncoming(event: ChatEvent): void {
    const now = Date.now();
    this.maybePrune(now);

    const eventTimeMs =
      event.eventTimeMs && Number.isFinite(event.eventTimeMs) ? event.eventTimeMs : now;
    const text = normalizeText(event.text);
    const keywords = tokenizeTopic(text);
    const emotion = inferEmotion(text);

    const previousUser = this.users.get(event.userId);
    const mergedEmotion = mergeEmotion(previousUser, emotion);
    const user: UserLiveState = previousUser ?? {
      userId: event.userId,
      displayName: event.senderName,
      totalMessages: 0,
      repliedMessages: 0,
      emotionLabel: "neutral",
      emotionScore: 0,
      lastSeenAt: eventTimeMs,
      keywordWeights: new Map<string, number>(),
    };
    user.displayName = event.senderName?.trim() || user.displayName;
    user.totalMessages += 1;
    user.lastSeenAt = eventTimeMs;
    user.emotionLabel = mergedEmotion.label;
    user.emotionScore = mergedEmotion.score;
    if (keywords.length > 0) {
      for (const keyword of keywords) {
        user.keywordWeights.set(keyword, (user.keywordWeights.get(keyword) ?? 0) + 1);
      }
      const sortedKeywords = Array.from(user.keywordWeights.entries()).sort((a, b) => b[1] - a[1]);
      user.keywordWeights = new Map(sortedKeywords.slice(0, MAX_USER_KEYWORDS));
    }
    this.users.set(event.userId, user);

    const sessionKey = createSessionKey(event);
    const session = this.sessions.get(sessionKey) ?? {
      sessionKey,
      lastUpdatedAt: eventTimeMs,
      turns: 0,
      lastUserText: "",
      lastReplyText: "",
    };
    session.lastUpdatedAt = eventTimeMs;
    session.turns += 1;
    session.lastUserText = text;
    this.sessions.set(sessionKey, session);

    if (event.scope !== "group" || typeof event.groupId !== "number") {
      return;
    }

    const previousGroup = this.groups.get(event.groupId);
    const group: GroupLiveState = previousGroup ?? {
      groupId: event.groupId,
      lastMessageAt: eventTimeMs,
      totalMessages: 0,
      recentMessages: [],
      topic: "暂无稳定话题",
      topicKeywords: [],
      lastProactiveAt: 0,
    };
    group.lastMessageAt = eventTimeMs;
    group.totalMessages += 1;
    if (text) {
      group.recentMessages.push({
        userId: event.userId,
        text,
        ts: eventTimeMs,
        keywords,
      });
      group.recentMessages = toRecentWindow(group.recentMessages, eventTimeMs).slice(-MAX_GROUP_SAMPLES);
      const nextTopic = buildTopic(group.recentMessages);
      group.topic = nextTopic.topic;
      group.topicKeywords = nextTopic.keywords;
    } else {
      group.recentMessages = toRecentWindow(group.recentMessages, eventTimeMs);
    }
    this.groups.set(event.groupId, group);
    this.enforceCapacity();
  }

  recordReply(event: ChatEvent, replyText: string): void {
    const now = Date.now();
    this.maybePrune(now);

    const user = this.users.get(event.userId);
    if (user) {
      user.repliedMessages += 1;
      this.users.set(event.userId, user);
    }

    const sessionKey = createSessionKey(event);
    const session = this.sessions.get(sessionKey);
    if (session) {
      session.lastReplyText = normalizeText(replyText);
      session.lastUpdatedAt = now;
      this.sessions.set(sessionKey, session);
    }
  }

  getPromptState(event: ChatEvent): PromptStateContext {
    this.maybePrune(Date.now());

    const user = this.users.get(event.userId);
    const group = event.scope === "group" && typeof event.groupId === "number" ? this.groups.get(event.groupId) : undefined;
    const affinity = describeAffinity(user?.totalMessages ?? 0, user?.repliedMessages ?? 0);
    const emotionLabel = user?.emotionLabel ?? "neutral";
    const emotionScore = user?.emotionScore ?? 0;

    const userName = user?.displayName || event.senderName || `用户${event.userId}`;
    const userProfileText = `称呼:${userName} | 累计消息:${user?.totalMessages ?? 0} | 互动层级:${affinity.text}`;
    const relationshipText = `当前互动亲和度:${affinity.score >= 0.2 ? "偏高" : affinity.score <= -0.08 ? "偏低" : "中性"}`;

    if (!group) {
      return {
        emotionLabel,
        emotionScore,
        userProfileText,
        relationshipText,
        groupTopicText: "私聊场景",
        groupActivityText: "私聊场景",
      };
    }

    const recentMessages = toRecentWindow(group.recentMessages, Date.now());
    const participantCountRecent = new Set(recentMessages.map((item) => item.userId)).size;
    const activityText = describeGroupActivity(recentMessages.length, participantCountRecent);

    return {
      emotionLabel,
      emotionScore,
      userProfileText,
      relationshipText,
      groupTopicText: group.topic || "暂无稳定话题",
      groupActivityText: `${activityText}（近10分钟消息${recentMessages.length}条）`,
    };
  }

  getTriggerHints(event: ChatEvent): TriggerRuntimeHints {
    this.maybePrune(Date.now());

    const user = this.users.get(event.userId);
    const userAffinity = describeAffinity(user?.totalMessages ?? 0, user?.repliedMessages ?? 0).score;

    if (event.scope !== "group" || typeof event.groupId !== "number") {
      return {
        userAffinityBoost: userAffinity,
        topicRelevanceBoost: 0,
        groupHeatBoost: 0,
      };
    }

    const group = this.groups.get(event.groupId);
    if (!group) {
      return {
        userAffinityBoost: userAffinity,
        topicRelevanceBoost: 0,
        groupHeatBoost: 0,
      };
    }

    const textKeywords = tokenizeTopic(event.text);
    const topicKeywordSet = new Set(group.topicKeywords);
    const overlapCount = textKeywords.filter((keyword) => topicKeywordSet.has(keyword)).length;
    const topicRelevanceBoost = overlapCount > 0 ? clamp(overlapCount * 0.07, 0, 0.18) : 0;

    const recentMessages = toRecentWindow(group.recentMessages, Date.now());
    const groupHeatBoost = clamp((recentMessages.length - 8) / 120, -0.04, 0.08);

    return {
      userAffinityBoost: userAffinity,
      topicRelevanceBoost,
      groupHeatBoost,
    };
  }

  listGroupSnapshots(now = Date.now()): GroupStateSnapshot[] {
    this.maybePrune(now);

    return Array.from(this.groups.values()).map((group) => {
      const recentMessages = toRecentWindow(group.recentMessages, now);
      return {
        groupId: group.groupId,
        topic: group.topic,
        topicKeywords: group.topicKeywords.slice(),
        messageCountRecent: recentMessages.length,
        participantCountRecent: new Set(recentMessages.map((item) => item.userId)).size,
        lastMessageAt: group.lastMessageAt,
        lastProactiveAt: group.lastProactiveAt,
      };
    });
  }

  markProactiveSent(groupId: number, now = Date.now()): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.lastProactiveAt = now;
    this.groups.set(groupId, group);
  }

  getRuntimeStats(): ChatStateEngineRuntimeStats {
    return {
      users: this.users.size,
      groups: this.groups.size,
      sessions: this.sessions.size,
      lastPruneAt: this.lastPruneAt,
    };
  }

  private maybePrune(now: number): void {
    if (this.lastPruneAt > 0 && now - this.lastPruneAt < this.options.pruneIntervalMs) {
      return;
    }

    this.pruneUsers(now);
    this.pruneGroups(now);
    this.pruneSessions(now);
    this.lastPruneAt = now;
  }

  private enforceCapacity(): void {
    this.evictOverflow(this.users, this.options.userMax, (user) => user.lastSeenAt);
    this.evictOverflow(this.groups, this.options.groupMax, (group) => group.lastMessageAt);
    this.evictOverflow(this.sessions, this.options.sessionMax, (session) => session.lastUpdatedAt);
  }

  private pruneUsers(now: number): void {
    for (const [userId, user] of this.users.entries()) {
      if (now - user.lastSeenAt > this.options.userTtlMs) {
        this.users.delete(userId);
      }
    }
    this.evictOverflow(this.users, this.options.userMax, (user) => user.lastSeenAt);
  }

  private pruneGroups(now: number): void {
    for (const [groupId, group] of this.groups.entries()) {
      if (now - group.lastMessageAt > this.options.groupTtlMs) {
        this.groups.delete(groupId);
      }
    }
    this.evictOverflow(this.groups, this.options.groupMax, (group) => group.lastMessageAt);
  }

  private pruneSessions(now: number): void {
    for (const [sessionKey, session] of this.sessions.entries()) {
      if (now - session.lastUpdatedAt > this.options.sessionTtlMs) {
        this.sessions.delete(sessionKey);
      }
    }
    this.evictOverflow(this.sessions, this.options.sessionMax, (session) => session.lastUpdatedAt);
  }

  private evictOverflow<TKey, TValue>(
    target: Map<TKey, TValue>,
    maxSize: number,
    getTimestamp: (value: TValue) => number,
  ): void {
    const overflow = target.size - maxSize;
    if (overflow <= 0) return;

    const sorted = Array.from(target.entries()).sort((left, right) => {
      return getTimestamp(left[1]) - getTimestamp(right[1]);
    });

    for (let index = 0; index < overflow; index += 1) {
      const item = sorted[index];
      if (!item) break;
      target.delete(item[0]);
    }
  }
}

export const chatStateEngine = new ChatStateEngine();
