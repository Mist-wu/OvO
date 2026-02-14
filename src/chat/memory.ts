import path from "node:path";

import { clipText, normalizePositiveInt } from "../utils/helpers";

import { config } from "../config";
import {
  ChatMemoryStore,
  type MemoryFactCategory,
  type SessionSummary,
} from "../storage/chat_memory_store";
import type { InMemorySessionStore } from "./session_store";
import type { ChatEvent, SessionMessage } from "./types";

export type ChatMemoryContext = {
  userDisplayName?: string;
  longTermFacts: string[];
  archivedSummaries: string[];
};

type FactCandidate = {
  category: MemoryFactCategory;
  content: string;
};



function dedupeFacts(candidates: FactCandidate[]): FactCandidate[] {
  const seen = new Set<string>();
  const result: FactCandidate[] = [];
  for (const item of candidates) {
    const content = item.content.replace(/\s+/g, " ").trim();
    if (!content) continue;
    const key = `${item.category}:${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ category: item.category, content });
  }
  return result;
}

export function extractFactCandidates(text: string): FactCandidate[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || normalized.startsWith("/")) return [];

  const results: FactCandidate[] = [];
  const addMatches = (regex: RegExp, category: MemoryFactCategory, mapper?: (value: string) => string) => {
    for (const match of normalized.matchAll(regex)) {
      const captured = (match[1] ?? "").trim();
      if (!captured) continue;
      const value = mapper ? mapper(captured) : captured;
      if (!value) continue;
      const clipped = clipText(value, 40);
      if (!clipped) continue;
      results.push({ category, content: clipped });
    }
  };

  addMatches(/(?:我叫|叫我)\s*([^，。！？\n]{1,20})/g, "identity", (value) => `称呼:${value}`);
  addMatches(/我是\s*([^，。！？\n]{1,20})/g, "identity", (value) => `身份:${value}`);

  addMatches(
    /我(?:比较|更|最)?(?:喜欢|爱)\s*([^，。！？\n]{1,24})/g,
    "preference",
    (value) => `喜欢:${value}`,
  );
  addMatches(
    /我(?:不喜欢|讨厌)\s*([^，。！？\n]{1,24})/g,
    "preference",
    (value) => `不喜欢:${value}`,
  );

  for (const match of normalized.matchAll(/我和\s*([^，。！？\n]{1,20})\s*(?:是|关系)\s*([^，。！？\n]{1,20})/g)) {
    const first = (match[1] ?? "").trim();
    const second = (match[2] ?? "").trim();
    if (!first || !second) continue;
    results.push({
      category: "relationship",
      content: clipText(`关系:${first}-${second}`, 40),
    });
  }

  if (/(梗|黑话|口头禅|meme)/i.test(normalized) && normalized.length <= 60) {
    results.push({ category: "meme", content: clipText(normalized, 50) });
  }

  if (/^我[^，。！？\n]{2,40}$/.test(normalized)) {
    results.push({ category: "other", content: clipText(normalized, 40) });
  }

  return dedupeFacts(results);
}

function summarizeArchivedChunk(chunk: SessionMessage[]): string {
  const userParts = chunk
    .filter((item) => item.role === "user")
    .map((item) => clipText(item.text, 28))
    .filter(Boolean);
  const assistantParts = chunk
    .filter((item) => item.role === "assistant")
    .map((item) => clipText(item.text, 28))
    .filter(Boolean);

  const blocks: string[] = [];
  if (userParts.length > 0) {
    blocks.push(`用户提到：${userParts.join("；")}`);
  }
  if (assistantParts.length > 0) {
    blocks.push(`小o回应：${assistantParts.join("；")}`);
  }
  return blocks.join("。");
}

function resolveMemoryPath(): string {
  const rawPath = config.chat.memoryPath || "data/chat_memory.json";
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function mapCategoryLabel(category: MemoryFactCategory): string {
  switch (category) {
    case "identity":
      return "身份";
    case "preference":
      return "偏好";
    case "relationship":
      return "关系";
    case "meme":
      return "梗";
    case "other":
      return "信息";
  }
}

function normalizeSummaryTexts(summaries: SessionSummary[]): string[] {
  return summaries.map((item) => item.summary).filter(Boolean);
}

export class ChatMemoryManager {
  private readonly store: ChatMemoryStore | null;

  constructor(private readonly sessions: InMemorySessionStore) {
    if (!config.chat.memoryEnabled) {
      this.store = null;
      return;
    }

    this.store = new ChatMemoryStore(resolveMemoryPath(), {
      maxFactsPerUser: config.chat.memoryMaxFactsPerUser,
      maxSummariesPerSession: config.chat.summaryArchiveMaxPerSession,
    });
  }

  getContext(event: ChatEvent, sessionKey: string): ChatMemoryContext {
    if (!this.store) {
      return {
        longTermFacts: [],
        archivedSummaries: [],
      };
    }

    const facts = this.store
      .getUserFacts(event.userId, config.chat.memoryContextFactCount)
      .map((item) => `[${mapCategoryLabel(item.category)}] ${item.content}`);
    const summaries = normalizeSummaryTexts(
      this.store.getSessionSummaries(sessionKey, config.chat.summaryContextCount),
    );

    return {
      userDisplayName: this.store.getUserDisplayName(event.userId),
      longTermFacts: facts,
      archivedSummaries: summaries,
    };
  }

  recordTurn(input: {
    event: ChatEvent;
    sessionKey: string;
    userText: string;
  }): void {
    if (!this.store) return;

    this.store.touchUser(input.event.userId, input.event.senderName);
    for (const fact of extractFactCandidates(input.userText)) {
      this.store.rememberFact(input.event.userId, fact.category, fact.content);
    }

    this.archiveIfNeeded(input.sessionKey);
  }

  private archiveIfNeeded(sessionKey: string): void {
    if (!this.store) return;

    const trigger = normalizePositiveInt(config.chat.summaryArchiveTriggerMessages, 18);
    const keepLatest = Math.max(
      2,
      normalizePositiveInt(config.chat.summaryArchiveKeepLatestMessages, 10),
    );
    const chunkSize = Math.max(2, normalizePositiveInt(config.chat.summaryArchiveChunkMessages, 8));

    const history = this.sessions.get(sessionKey);
    if (history.length < trigger) return;
    if (history.length <= keepLatest) return;

    const removable = history.length - keepLatest;
    const archiveCount = Math.min(chunkSize, removable);
    if (archiveCount <= 0) return;

    const archived = this.sessions.takeOldest(sessionKey, archiveCount);
    if (archived.length <= 0) return;

    const summary = summarizeArchivedChunk(archived);
    if (!summary) return;

    this.store.appendSessionSummary(sessionKey, summary, archived.length);
  }
}
