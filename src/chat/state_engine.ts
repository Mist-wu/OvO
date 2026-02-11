import { createSessionKey } from "./session_store";
import type { ChatEvent } from "./types";

export type EmotionLabel = "positive" | "neutral" | "negative" | "curious" | "excited";

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
const STOP_WORDS = new Set([
  "这个",
  "那个",
  "就是",
  "然后",
  "感觉",
  "你们",
  "我们",
  "他们",
  "今天",
  "明天",
  "现在",
  "一下",
  "一下子",
  "可以",
  "是不是",
  "怎么",
  "为什么",
  "什么",
  "一个",
  "没有",
  "真的",
  "哈哈",
  "hhh",
  "ok",
  "好的",
  "一下",
  "吗",
  "呢",
  "啊",
  "呀",
  "啦",
  "了",
]);

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

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
  if (/(开心|高兴|喜欢|赞|太棒|牛|厉害|哈哈|笑死|好耶)/.test(normalized)) score += 0.5;
  if (/(难受|烦|气死|无语|崩溃|累|糟糕|讨厌|服了|离谱)/.test(normalized)) score -= 0.55;
  if (/(吗|呢|\?|？|为啥|为什么|怎么|咋)/.test(normalized)) score += 0.12;
  if (/[!！]{1,}/.test(normalized)) score += 0.18;
  if (/(哇|卧槽|逆天|太强|炸裂)/.test(normalized)) score += 0.25;

  const clipped = clamp(score, -1, 1);
  if (clipped >= 0.42) return { label: "positive", score: clipped };
  if (clipped >= 0.22) return { label: "excited", score: clipped };
  if (clipped <= -0.38) return { label: "negative", score: clipped };
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
    clipped >= 0.42
      ? "positive"
      : clipped >= 0.22
        ? "excited"
        : clipped <= -0.38
          ? "negative"
          : next.label === "curious" && clipped > -0.12
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

  recordIncoming(event: ChatEvent): void {
    const now = event.eventTimeMs && Number.isFinite(event.eventTimeMs) ? event.eventTimeMs : Date.now();
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
      lastSeenAt: now,
      keywordWeights: new Map<string, number>(),
    };
    user.displayName = event.senderName?.trim() || user.displayName;
    user.totalMessages += 1;
    user.lastSeenAt = now;
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
      lastUpdatedAt: now,
      turns: 0,
      lastUserText: "",
      lastReplyText: "",
    };
    session.lastUpdatedAt = now;
    session.turns += 1;
    session.lastUserText = text;
    this.sessions.set(sessionKey, session);

    if (event.scope !== "group" || typeof event.groupId !== "number") {
      return;
    }

    const previousGroup = this.groups.get(event.groupId);
    const group: GroupLiveState = previousGroup ?? {
      groupId: event.groupId,
      lastMessageAt: now,
      totalMessages: 0,
      recentMessages: [],
      topic: "暂无稳定话题",
      topicKeywords: [],
      lastProactiveAt: 0,
    };
    group.lastMessageAt = now;
    group.totalMessages += 1;
    if (text) {
      group.recentMessages.push({
        userId: event.userId,
        text,
        ts: now,
        keywords,
      });
      group.recentMessages = toRecentWindow(group.recentMessages, now).slice(-MAX_GROUP_SAMPLES);
      const nextTopic = buildTopic(group.recentMessages);
      group.topic = nextTopic.topic;
      group.topicKeywords = nextTopic.keywords;
    } else {
      group.recentMessages = toRecentWindow(group.recentMessages, now);
    }
    this.groups.set(event.groupId, group);
  }

  recordReply(event: ChatEvent, replyText: string): void {
    const now = Date.now();
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
}

export const chatStateEngine = new ChatStateEngine();
