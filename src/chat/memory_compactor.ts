import path from "node:path";

import { config } from "../config";
import { askGemini } from "../llm";
import {
  ChatMemoryStore,
  type MemoryFactCategory,
  type MemoryFactPatchInput,
  type SessionSummaryPatchInput,
} from "../storage/chat_memory_store";

type UserCompactResult = {
  target: "user";
  userId: number;
  before: number;
  after: number;
  note?: string;
};

type SessionCompactResult = {
  target: "session";
  sessionKey: string;
  before: number;
  after: number;
  note?: string;
};

export type MemoryCompactResult = UserCompactResult | SessionCompactResult;

function resolveMemoryPath(): string {
  const rawPath = config.chat.memoryPath || "data/chat_memory.json";
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(process.cwd(), rawPath);
}

function createStore(): ChatMemoryStore {
  return new ChatMemoryStore(resolveMemoryPath(), {
    maxFactsPerUser: config.chat.memoryMaxFactsPerUser,
    maxSummariesPerSession: config.chat.summaryArchiveMaxPerSession,
  });
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("LLM 返回空内容");
  }

  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fencedMatch?.[1]?.trim() || trimmed;

  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("LLM 返回内容不是有效 JSON");
    }
    return JSON.parse(raw.slice(start, end + 1));
  }
}

function normalizeCategory(value: unknown): MemoryFactCategory | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    normalized === "identity" ||
    normalized === "preference" ||
    normalized === "relationship" ||
    normalized === "meme" ||
    normalized === "other"
  ) {
    return normalized;
  }
  return null;
}

function parseFactPatchList(value: unknown): MemoryFactPatchInput[] {
  if (!Array.isArray(value)) return [];
  const result: MemoryFactPatchInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const parsed = item as { category?: unknown; content?: unknown };
    const category = normalizeCategory(parsed.category);
    const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
    if (!category || !content) continue;
    result.push({ category, content });
  }
  return result;
}

function parseSummaryPatchList(value: unknown): SessionSummaryPatchInput[] {
  if (!Array.isArray(value)) return [];
  const result: SessionSummaryPatchInput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const parsed = item as { summary?: unknown; archivedMessageCount?: unknown };
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) continue;
    const archivedMessageCount =
      typeof parsed.archivedMessageCount === "number" && Number.isFinite(parsed.archivedMessageCount)
        ? Math.max(1, Math.floor(parsed.archivedMessageCount))
        : undefined;
    result.push({ summary, archivedMessageCount });
  }
  return result;
}

function buildUserCompactPrompt(input: {
  userId: number;
  displayName?: string;
  facts: Array<{ category: string; content: string; updatedAt: number }>;
}): string {
  return [
    "你是聊天记忆整理器。你的任务是压缩并整理用户长期记忆 facts。",
    "要求：",
    "1. 仅输出 JSON，不要解释，不要 markdown。",
    "2. 合并同类重复项（尤其 preference/identity）。",
    "3. 删除冗余、近似重复、信息量低或明显重复表达。",
    "4. 保留更清晰、更稳定、更有用的表述。",
    "5. 不要编造新事实；只能基于输入重组/删减/合并。",
    '6. 输出格式：{"facts":[{"category":"identity|preference|relationship|meme|other","content":"..."}],"note":"可选简短说明"}',
    "",
    `userId=${input.userId}`,
    `displayName=${input.displayName ?? ""}`,
    "原始 facts：",
    JSON.stringify(input.facts, null, 2),
  ].join("\n");
}

function buildSessionCompactPrompt(input: {
  sessionKey: string;
  summaries: Array<{ summary: string; archivedMessageCount: number; createdAt: number }>;
}): string {
  return [
    "你是聊天摘要整理器。你的任务是压缩并整理会话 summaries。",
    "要求：",
    "1. 仅输出 JSON，不要解释，不要 markdown。",
    "2. 合并高度重复或近似重复的摘要。",
    "3. 删除冗余内容，保留关键信息。",
    "4. 不要编造新信息；只能基于输入做删减/合并/重写。",
    '5. 输出格式：{"summaries":[{"summary":"...","archivedMessageCount":数字}],"note":"可选简短说明"}',
    "",
    `sessionKey=${input.sessionKey}`,
    "原始 summaries：",
    JSON.stringify(input.summaries, null, 2),
  ].join("\n");
}

export async function compactUserMemoryWithLlm(userId: number): Promise<MemoryCompactResult> {
  const store = createStore();
  const user = store.getUserMemory(userId);
  if (!user) {
    throw new Error(`用户 ${userId} 不存在记忆`);
  }
  if (user.facts.length <= 0) {
    return {
      target: "user",
      userId,
      before: 0,
      after: 0,
      note: "无 facts，可跳过",
    };
  }

  const response = await askGemini(
    buildUserCompactPrompt({
      userId,
      displayName: user.displayName,
      facts: user.facts,
    }),
  );
  const parsed = extractJsonObject(response) as { facts?: unknown; note?: unknown };
  const facts = parseFactPatchList(parsed.facts);
  if (facts.length <= 0 && user.facts.length > 0) {
    throw new Error("LLM 压缩结果为空，已拒绝写入");
  }
  const replaced = store.replaceUserFacts(userId, facts);
  return {
    target: "user",
    userId,
    before: replaced.before,
    after: replaced.after,
    note: typeof parsed.note === "string" ? parsed.note.trim() : undefined,
  };
}

export async function compactSessionMemoryWithLlm(sessionKey: string): Promise<MemoryCompactResult> {
  const store = createStore();
  const session = store.getSessionMemory(sessionKey);
  if (!session) {
    throw new Error(`会话 ${sessionKey} 不存在摘要`);
  }
  if (session.summaries.length <= 0) {
    return {
      target: "session",
      sessionKey,
      before: 0,
      after: 0,
      note: "无 summaries，可跳过",
    };
  }

  const response = await askGemini(
    buildSessionCompactPrompt({
      sessionKey,
      summaries: session.summaries,
    }),
  );
  const parsed = extractJsonObject(response) as { summaries?: unknown; note?: unknown };
  const summaries = parseSummaryPatchList(parsed.summaries);
  if (summaries.length <= 0 && session.summaries.length > 0) {
    throw new Error("LLM 压缩结果为空，已拒绝写入");
  }
  const replaced = store.replaceSessionSummaries(sessionKey, summaries);
  return {
    target: "session",
    sessionKey,
    before: replaced.before,
    after: replaced.after,
    note: typeof parsed.note === "string" ? parsed.note.trim() : undefined,
  };
}

