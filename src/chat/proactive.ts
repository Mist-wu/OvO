import type { GroupStateSnapshot } from "./state_engine";

export type ProactiveReason = "cold_start_breaker" | "timed_bubble" | "topic_continuation";

export type ProactiveCandidate = {
  groupId: number;
  reason: ProactiveReason;
  topic: string;
  messageCountRecent: number;
};

export type ProactiveDecisionInput = {
  snapshots: GroupStateSnapshot[];
  now: number;
  enabledGroups: Set<number>;
  idleMs: number;
  continueIdleMs: number;
  minGapMs: number;
  bubbleIntervalMs: number;
  minRecentMessages: number;
  maxPerTick: number;
};

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

function hasTopic(snapshot: GroupStateSnapshot): boolean {
  return snapshot.topicKeywords.length > 0 && snapshot.topic !== "暂无稳定话题";
}

function sortByPriority(candidates: ProactiveCandidate[]): ProactiveCandidate[] {
  const priorityByReason: Record<ProactiveReason, number> = {
    cold_start_breaker: 0,
    topic_continuation: 1,
    timed_bubble: 2,
  };
  return candidates.sort((left, right) => {
    const p = priorityByReason[left.reason] - priorityByReason[right.reason];
    if (p !== 0) return p;
    return right.messageCountRecent - left.messageCountRecent;
  });
}

export function decideProactiveActions(input: ProactiveDecisionInput): ProactiveCandidate[] {
  const candidates: ProactiveCandidate[] = [];
  const idleMs = normalizePositiveInt(input.idleMs, 4 * 60 * 1000);
  const continueIdleMs = normalizePositiveInt(input.continueIdleMs, 90 * 1000);
  const minGapMs = normalizePositiveInt(input.minGapMs, 6 * 60 * 1000);
  const bubbleIntervalMs = normalizePositiveInt(input.bubbleIntervalMs, 25 * 60 * 1000);
  const minRecentMessages = normalizeNonNegativeInt(input.minRecentMessages, 6);
  const maxPerTick = normalizePositiveInt(input.maxPerTick, 1);

  for (const snapshot of input.snapshots) {
    if (!input.enabledGroups.has(snapshot.groupId)) continue;
    if (snapshot.lastMessageAt <= 0) continue;

    const sinceLastMessage = input.now - snapshot.lastMessageAt;
    const sinceLastProactive =
      snapshot.lastProactiveAt > 0 ? input.now - snapshot.lastProactiveAt : Number.POSITIVE_INFINITY;

    if (sinceLastProactive < minGapMs) {
      continue;
    }

    if (sinceLastMessage >= idleMs && snapshot.messageCountRecent < minRecentMessages) {
      candidates.push({
        groupId: snapshot.groupId,
        reason: "cold_start_breaker",
        topic: snapshot.topic,
        messageCountRecent: snapshot.messageCountRecent,
      });
      continue;
    }

    if (
      hasTopic(snapshot) &&
      sinceLastMessage >= continueIdleMs &&
      snapshot.messageCountRecent >= minRecentMessages
    ) {
      candidates.push({
        groupId: snapshot.groupId,
        reason: "topic_continuation",
        topic: snapshot.topic,
        messageCountRecent: snapshot.messageCountRecent,
      });
      continue;
    }

    if (sinceLastProactive >= bubbleIntervalMs && sinceLastMessage >= continueIdleMs) {
      candidates.push({
        groupId: snapshot.groupId,
        reason: "timed_bubble",
        topic: snapshot.topic,
        messageCountRecent: snapshot.messageCountRecent,
      });
    }
  }

  return sortByPriority(candidates).slice(0, maxPerTick);
}

function pickTemplate(templates: string[], seed: number): string {
  if (templates.length <= 0) return "";
  const index = Math.abs(Math.floor(seed)) % templates.length;
  return templates[index];
}

export function buildProactiveText(candidate: ProactiveCandidate, now: number): string {
  const seed = now + candidate.groupId;
  if (candidate.reason === "cold_start_breaker") {
    const templates = [
      "冒个泡，大家最近在忙啥？",
      "有点安静，来点今日份近况？",
      "打卡一下，今天有什么新鲜事吗？",
    ];
    return pickTemplate(templates, seed);
  }

  if (candidate.reason === "topic_continuation" && candidate.topic && candidate.topic !== "暂无稳定话题") {
    const templates = [
      `刚想到个延伸点：${candidate.topic} 这块你们更倾向哪种做法？`,
      `继续接上刚才的话题：${candidate.topic}，我还挺想听听你们的看法。`,
      `关于 ${candidate.topic}，你们最近有踩过什么坑吗？`,
    ];
    return pickTemplate(templates, seed);
  }

  const templates = [
    "定时冒泡一下，我在线～",
    "我来刷个存在感，最近有什么想聊的？",
    "路过冒个泡，有问题随时丢我。",
  ];
  return pickTemplate(templates, seed);
}
