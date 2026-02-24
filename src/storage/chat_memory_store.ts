import fs from "node:fs";
import path from "node:path";

import { normalizePositiveInt, normalizeText } from "../utils/helpers";
import { logger } from "../utils/logger";

export type MemoryFactCategory = "identity" | "preference" | "relationship" | "meme" | "other";

export type MemoryFact = {
  category: MemoryFactCategory;
  content: string;
  updatedAt: number;
};

export type UserMemory = {
  displayName?: string;
  facts: MemoryFact[];
  lastSeenAt: number;
};

export type SessionSummary = {
  summary: string;
  createdAt: number;
  archivedMessageCount: number;
};

type StoredSessionMemory = {
  summaries: SessionSummary[];
};

type StoredChatMemoryV1 = {
  version: 1;
  users: Record<string, UserMemory>;
  sessions: Record<string, StoredSessionMemory>;
};

const CURRENT_VERSION = 1;

export type MemoryFactPatchInput = {
  category: MemoryFactCategory;
  content: string;
};

export type SessionSummaryPatchInput = {
  summary: string;
  archivedMessageCount?: number;
};

function cloneFact(item: MemoryFact): MemoryFact {
  return { ...item };
}

function cloneSummary(item: SessionSummary): SessionSummary {
  return { ...item };
}

function cloneUserMemory(user: UserMemory): UserMemory {
  return {
    displayName: user.displayName,
    lastSeenAt: user.lastSeenAt,
    facts: user.facts.map(cloneFact),
  };
}



function normalizeFact(raw: unknown): MemoryFact | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<MemoryFact>;
  const content = typeof parsed.content === "string" ? parsed.content.trim() : "";
  if (!content) return null;

  const category = parsed.category;
  const normalizedCategory: MemoryFactCategory =
    category === "identity" ||
      category === "preference" ||
      category === "relationship" ||
      category === "meme" ||
      category === "other"
      ? category
      : "other";

  const updatedAt =
    typeof parsed.updatedAt === "number" && Number.isFinite(parsed.updatedAt)
      ? parsed.updatedAt
      : Date.now();

  return {
    category: normalizedCategory,
    content,
    updatedAt,
  };
}

function normalizeUserMemory(raw: unknown): UserMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<UserMemory>;
  const factsRaw = Array.isArray(parsed.facts) ? parsed.facts : [];
  const facts = factsRaw.map((item) => normalizeFact(item)).filter((item): item is MemoryFact => !!item);
  const displayName = typeof parsed.displayName === "string" ? parsed.displayName.trim() : "";
  const lastSeenAt =
    typeof parsed.lastSeenAt === "number" && Number.isFinite(parsed.lastSeenAt)
      ? parsed.lastSeenAt
      : Date.now();

  return {
    displayName: displayName || undefined,
    facts,
    lastSeenAt,
  };
}

function normalizeSessionSummary(raw: unknown): SessionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<SessionSummary>;
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  if (!summary) return null;

  const createdAt =
    typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt)
      ? parsed.createdAt
      : Date.now();
  const archivedMessageCount =
    typeof parsed.archivedMessageCount === "number" && Number.isFinite(parsed.archivedMessageCount)
      ? Math.max(1, Math.floor(parsed.archivedMessageCount))
      : 1;

  return {
    summary,
    createdAt,
    archivedMessageCount,
  };
}

function normalizeSessionMemory(raw: unknown): StoredSessionMemory {
  if (!raw || typeof raw !== "object") {
    return { summaries: [] };
  }
  const parsed = raw as Partial<StoredSessionMemory>;
  const summariesRaw = Array.isArray(parsed.summaries) ? parsed.summaries : [];
  const summaries = summariesRaw
    .map((item) => normalizeSessionSummary(item))
    .filter((item): item is SessionSummary => !!item);
  return { summaries };
}

function normalizeStore(raw: unknown): StoredChatMemoryV1 {
  if (!raw || typeof raw !== "object") {
    return { version: CURRENT_VERSION, users: {}, sessions: {} };
  }

  const parsed = raw as Partial<StoredChatMemoryV1> & { version?: unknown };
  const usersRaw = parsed.users && typeof parsed.users === "object" ? parsed.users : {};
  const sessionsRaw = parsed.sessions && typeof parsed.sessions === "object" ? parsed.sessions : {};

  const users: Record<string, UserMemory> = {};
  for (const [key, value] of Object.entries(usersRaw)) {
    const normalized = normalizeUserMemory(value);
    if (normalized) {
      users[key] = normalized;
    }
  }

  const sessions: Record<string, StoredSessionMemory> = {};
  for (const [key, value] of Object.entries(sessionsRaw)) {
    sessions[key] = normalizeSessionMemory(value);
  }

  return {
    version: CURRENT_VERSION,
    users,
    sessions,
  };
}



export class ChatMemoryStore {
  private data: StoredChatMemoryV1 = {
    version: CURRENT_VERSION,
    users: {},
    sessions: {},
  };

  private readonly maxFactsPerUser: number;
  private readonly maxSummariesPerSession: number;

  constructor(
    private readonly filePath: string,
    options?: {
      maxFactsPerUser?: number;
      maxSummariesPerSession?: number;
    },
  ) {
    this.maxFactsPerUser = normalizePositiveInt(options?.maxFactsPerUser ?? 40, 40);
    this.maxSummariesPerSession = normalizePositiveInt(options?.maxSummariesPerSession ?? 30, 30);
    this.load();
  }

  getUserDisplayName(userId: number): string | undefined {
    const user = this.data.users[String(userId)];
    return user?.displayName;
  }

  getUserFacts(userId: number, limit = 8): MemoryFact[] {
    const user = this.data.users[String(userId)];
    if (!user) return [];
    const normalizedLimit = normalizePositiveInt(limit, 8);
    return user.facts.slice(-normalizedLimit);
  }

  getUserMemory(userId: number): UserMemory | undefined {
    const user = this.data.users[String(userId)];
    return user ? cloneUserMemory(user) : undefined;
  }

  touchUser(userId: number, displayName?: string): void {
    const key = String(userId);
    const now = Date.now();
    const existing = this.data.users[key];
    const normalizedName = typeof displayName === "string" ? normalizeText(displayName) : "";

    if (!existing) {
      this.data.users[key] = {
        displayName: normalizedName || undefined,
        facts: [],
        lastSeenAt: now,
      };
      this.persist();
      return;
    }

    let changed = false;
    if (normalizedName && normalizedName !== existing.displayName) {
      existing.displayName = normalizedName;
      changed = true;
    }
    if (existing.lastSeenAt !== now) {
      existing.lastSeenAt = now;
      changed = true;
    }

    if (changed) {
      this.persist();
    }
  }

  rememberFact(userId: number, category: MemoryFactCategory, content: string): void {
    const normalized = normalizeText(content);
    if (!normalized) return;

    const key = String(userId);
    const now = Date.now();
    const user = this.data.users[key] ?? {
      facts: [],
      lastSeenAt: now,
    };

    const existingIndex = user.facts.findIndex(
      (item) => item.category === category && item.content === normalized,
    );

    if (existingIndex >= 0) {
      user.facts[existingIndex] = {
        ...user.facts[existingIndex],
        updatedAt: now,
      };
      const updated = user.facts[existingIndex];
      user.facts.splice(existingIndex, 1);
      user.facts.push(updated);
    } else {
      user.facts.push({
        category,
        content: normalized,
        updatedAt: now,
      });
      if (user.facts.length > this.maxFactsPerUser) {
        user.facts = user.facts.slice(user.facts.length - this.maxFactsPerUser);
      }
    }

    user.lastSeenAt = now;
    this.data.users[key] = user;
    this.persist();
  }

  getSessionSummaries(sessionKey: string, limit = 2): SessionSummary[] {
    const session = this.data.sessions[sessionKey];
    if (!session) return [];
    const normalizedLimit = normalizePositiveInt(limit, 2);
    return session.summaries.slice(-normalizedLimit);
  }

  getSessionMemory(sessionKey: string): { summaries: SessionSummary[] } | undefined {
    const session = this.data.sessions[sessionKey];
    if (!session) return undefined;
    return {
      summaries: session.summaries.map(cloneSummary),
    };
  }

  replaceUserFacts(userId: number, facts: MemoryFactPatchInput[]): { before: number; after: number } {
    const key = String(userId);
    const now = Date.now();
    const user = this.data.users[key] ?? {
      facts: [],
      lastSeenAt: now,
    };
    const nextFacts: MemoryFact[] = [];
    const seen = new Set<string>();

    for (const item of facts) {
      const category = item.category;
      if (!["identity", "preference", "relationship", "meme", "other"].includes(category)) {
        continue;
      }
      const content = normalizeText(item.content);
      if (!content) continue;
      const dedupeKey = `${category}:${content}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      nextFacts.push({
        category,
        content,
        updatedAt: now,
      });
    }

    const before = user.facts.length;
    user.facts =
      nextFacts.length > this.maxFactsPerUser
        ? nextFacts.slice(nextFacts.length - this.maxFactsPerUser)
        : nextFacts;
    user.lastSeenAt = now;
    this.data.users[key] = user;
    this.persist();
    return { before, after: user.facts.length };
  }

  replaceSessionSummaries(
    sessionKey: string,
    summaries: SessionSummaryPatchInput[],
  ): { before: number; after: number } {
    const now = Date.now();
    const session = this.data.sessions[sessionKey] ?? { summaries: [] };
    const nextSummaries: SessionSummary[] = [];
    const seen = new Set<string>();

    for (const item of summaries) {
      const summary = normalizeText(item.summary);
      if (!summary) continue;
      if (seen.has(summary)) continue;
      seen.add(summary);
      const archivedMessageCount =
        typeof item.archivedMessageCount === "number" && Number.isFinite(item.archivedMessageCount)
          ? Math.max(1, Math.floor(item.archivedMessageCount))
          : 1;
      nextSummaries.push({
        summary,
        archivedMessageCount,
        createdAt: now,
      });
    }

    const before = session.summaries.length;
    session.summaries =
      nextSummaries.length > this.maxSummariesPerSession
        ? nextSummaries.slice(nextSummaries.length - this.maxSummariesPerSession)
        : nextSummaries;
    this.data.sessions[sessionKey] = session;
    this.persist();
    return { before, after: session.summaries.length };
  }

  appendSessionSummary(sessionKey: string, summary: string, archivedMessageCount: number): void {
    const normalizedSummary = normalizeText(summary);
    if (!normalizedSummary) return;

    const session = this.data.sessions[sessionKey] ?? { summaries: [] };
    const normalizedCount = Math.max(1, Math.floor(archivedMessageCount));
    session.summaries.push({
      summary: normalizedSummary,
      createdAt: Date.now(),
      archivedMessageCount: normalizedCount,
    });

    if (session.summaries.length > this.maxSummariesPerSession) {
      session.summaries = session.summaries.slice(
        session.summaries.length - this.maxSummariesPerSession,
      );
    }

    this.data.sessions[sessionKey] = session;
    this.persist();
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.persist();
      return;
    }

    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.data = normalizeStore(parsed);
      const version =
        parsed && typeof parsed === "object"
          ? (parsed as { version?: unknown }).version
          : undefined;
      if (version !== CURRENT_VERSION) {
        this.persist();
      }
    } catch (error) {
      logger.warn("[chat_memory_store] 读取失败，已重置:", error);
      this.data = { version: CURRENT_VERSION, users: {}, sessions: {} };
      this.persist();
    }
  }

  private persist(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });

    const payload = JSON.stringify(this.data, null, 2);
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, payload, "utf8");
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
    fs.renameSync(tmpPath, this.filePath);
  }
}
