import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { MessageSegment } from "../napcat/message";
import { logger } from "../utils/logger";

type UserCounter = {
  name: string;
  count: number;
};

type EmojiCounter = {
  key: string;
  label: string;
  count: number;
  assetRef?: string;
  kind: "image" | "face" | "mface";
};

type GroupDailyStats = {
  messageUsers: Record<string, UserCounter>;
  emojiUsers: Record<string, UserCounter>;
  emojis: Record<string, EmojiCounter>;
  totalMessages: number;
  totalEmojiUses: number;
};

type DailyStatsBucket = {
  groups: Record<string, GroupDailyStats>;
};

type SignInUserRecord = {
  userId: number;
  userName: string;
  totalDays: number;
  streakDays: number;
  lastDateKey: string;
  totalPoints: number;
};

type SignInDayBucket = {
  users: Record<string, { userName: string; signedAt: number; seq: number }>;
  count: number;
};

type GroupSignInBucket = {
  profiles: Record<string, SignInUserRecord>;
  days: Record<string, SignInDayBucket>;
};

type GlobalSignInDayBucket = {
  users: Record<string, { userName: string; signedAt: number; seq: number; rewardPoints: number }>;
  count: number;
};

type SignInGlobalBucket = {
  profiles: Record<string, SignInUserRecord>;
  days: Record<string, GlobalSignInDayBucket>;
};

type SignInScopeBucket = {
  groups: Record<string, GroupSignInBucket>;
  privates: Record<string, GroupSignInBucket>;
  global: SignInGlobalBucket;
};

type ActivityStoreData = {
  version: 1;
  daily: Record<string, DailyStatsBucket>;
  signIn: SignInScopeBucket;
};

export type DailyRankItem = {
  userId: number;
  userName: string;
  count: number;
  percent: number;
};

export type DailyTalkStatsResult = {
  titleDateKey: string;
  generatedAtMs: number;
  groupId: number;
  items: DailyRankItem[];
  totalCount: number;
  participantCount: number;
};

export type DailyEmojiStatsResult = DailyTalkStatsResult;

export type TotalPointsRankResult = {
  generatedAtMs: number;
  items: DailyRankItem[];
  totalPoints: number;
  participantCount: number;
};

export type TopEmojiItem = {
  key: string;
  label: string;
  count: number;
  kind: "image" | "face" | "mface";
  assetRef?: string;
};

export type SignInResult = {
  scope: "group" | "private";
  scopeId: number;
  userId: number;
  userName: string;
  dateKey: string;
  signedAtMs: number;
  status: "signed" | "already_signed";
  seqToday: number;
  todayTotal: number;
  totalDays: number;
  streakDays: number;
  totalPoints: number;
  rewardPoints: number;
};

export type RechargePointsResult = {
  userId: number;
  userName: string;
  addedPoints: number;
  totalPoints: number;
  operatedAtMs: number;
};

export type TransferPointsResult = {
  fromUserId: number;
  fromUserName: string;
  toUserId: number;
  toUserName: string;
  transferredPoints: number;
  fromTotalPoints: number;
  toTotalPoints: number;
  operatedAtMs: number;
};

export type UserPointsSnapshot = {
  userId: number;
  userName: string;
  totalPoints: number;
};

const CURRENT_VERSION = 1;
const STORE_PATH = path.resolve(process.cwd(), "data/activity_stats.json");
const EMOJI_ASSET_DIR = path.resolve(process.cwd(), "data/emoji_assets");
const MAX_DAILY_BUCKETS = 35;
const emojiHttpDownloadTasks: Map<string, Promise<string | undefined>> = new Map();

function createEmptyData(): ActivityStoreData {
  return {
    version: CURRENT_VERSION,
    daily: {},
    signIn: {
      groups: {},
      privates: {},
      global: {
        profiles: {},
        days: {},
      },
    },
  };
}

function normalizeRecord<T>(value: unknown, fallback: T): T {
  return value && typeof value === "object" ? (value as T) : fallback;
}

function formatDateKeyCN(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "1970-01-01";
  }
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const map: Record<string, string> = {};
  for (const part of parts) {
    map[part.type] = part.value;
  }
  return `${map.year ?? "1970"}-${map.month ?? "01"}-${map.day ?? "01"}`;
}

function normalizeUserName(input: string | undefined, userId: number): string {
  const name = (input ?? "").trim();
  return name || `用户${userId}`;
}

function getOrCreateGroupDailyStats(bucket: DailyStatsBucket, groupId: number): GroupDailyStats {
  const key = String(groupId);
  if (!bucket.groups[key]) {
    bucket.groups[key] = {
      messageUsers: {},
      emojiUsers: {},
      emojis: {},
      totalMessages: 0,
      totalEmojiUses: 0,
    };
  }
  return bucket.groups[key]!;
}

function getOrCreateDailyBucket(data: ActivityStoreData, dateKey: string): DailyStatsBucket {
  if (!data.daily[dateKey]) {
    data.daily[dateKey] = { groups: {} };
  }
  return data.daily[dateKey]!;
}

function getOrCreateSignInGroupBucket(
  data: ActivityStoreData,
  scope: "group" | "private",
  scopeId: number,
): GroupSignInBucket {
  const root = scope === "group" ? data.signIn.groups : data.signIn.privates;
  const key = String(scopeId);
  if (!root[key]) {
    root[key] = {
      profiles: {},
      days: {},
    };
  }
  return root[key]!;
}

function getOrCreateSignInDayBucket(group: GroupSignInBucket, dateKey: string): SignInDayBucket {
  if (!group.days[dateKey]) {
    group.days[dateKey] = {
      users: {},
      count: 0,
    };
  }
  return group.days[dateKey]!;
}

function getOrCreateGlobalSignInBucket(data: ActivityStoreData): SignInGlobalBucket {
  if (!data.signIn.global) {
    data.signIn.global = { profiles: {}, days: {} };
  }
  return data.signIn.global;
}

function getOrCreateGlobalSignInDayBucket(bucket: SignInGlobalBucket, dateKey: string): GlobalSignInDayBucket {
  if (!bucket.days[dateKey]) {
    bucket.days[dateKey] = {
      users: {},
      count: 0,
    };
  }
  return bucket.days[dateKey]!;
}

function randomSignInRewardPoints(): number {
  return crypto.randomInt(10, 21);
}

function normalizeSignInProfile(input: Partial<SignInUserRecord> | undefined, userId: number, userName: string): SignInUserRecord {
  return {
    userId,
    userName,
    totalDays: typeof input?.totalDays === "number" && Number.isFinite(input.totalDays) ? Math.max(0, Math.floor(input.totalDays)) : 0,
    streakDays: typeof input?.streakDays === "number" && Number.isFinite(input.streakDays) ? Math.max(0, Math.floor(input.streakDays)) : 0,
    lastDateKey: typeof input?.lastDateKey === "string" ? input.lastDateKey : "",
    totalPoints: typeof input?.totalPoints === "number" && Number.isFinite(input.totalPoints) ? Math.max(0, Math.floor(input.totalPoints)) : 0,
  };
}

function incrementUserCounter(
  record: Record<string, UserCounter>,
  userId: number,
  userName: string,
  delta = 1,
): void {
  const key = String(userId);
  const current = record[key];
  if (!current) {
    record[key] = { name: userName, count: delta };
    return;
  }
  current.name = userName || current.name;
  current.count += delta;
}

function extractSegmentDataField(segment: MessageSegment, key: string): string {
  const value = (segment.data as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isLikelyFilePath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("file://")) return true;
  if (/^[a-zA-Z]:\\/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  return false;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function extByMime(mimeType: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
  };
  return map[mimeType.toLowerCase()] ?? ".img";
}

function inferExtFromSource(source: string): string {
  const clean = source.split("?")[0];
  const ext = path.extname(clean).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"].includes(ext)) {
    return ext === ".jpeg" ? ".jpg" : ext;
  }
  return ".img";
}

function sha1(input: Buffer | string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function toLocalFilePath(source: string): string {
  return source.startsWith("file://") ? fileURLToPath(source) : source;
}

function parseDataUriImage(source: string): { buffer: Buffer; ext: string } | null {
  const matched = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!matched) return null;
  try {
    return {
      buffer: Buffer.from(matched[2], "base64"),
      ext: extByMime(matched[1]),
    };
  } catch {
    return null;
  }
}

function parseBase64PseudoUri(source: string): { buffer: Buffer; ext: string } | null {
  if (!source.startsWith("base64://")) return null;
  try {
    return {
      buffer: Buffer.from(source.slice("base64://".length), "base64"),
      ext: ".jpg",
    };
  } catch {
    return null;
  }
}

function persistImageAsset(source: string): { key: string; assetRef?: string; label: string } {
  ensureDir(EMOJI_ASSET_DIR);

  const fromDataUri = parseDataUriImage(source) ?? parseBase64PseudoUri(source);
  if (fromDataUri) {
    const hash = sha1(fromDataUri.buffer);
    const filePath = path.join(EMOJI_ASSET_DIR, `${hash}${fromDataUri.ext}`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, fromDataUri.buffer);
    }
    return { key: `img:${hash}`, assetRef: filePath, label: "表情包" };
  }

  if (isLikelyFilePath(source)) {
    const localPath = toLocalFilePath(source);
    try {
      if (fs.existsSync(localPath)) {
        const stat = fs.statSync(localPath);
        if (stat.isFile()) {
          const buffer = fs.readFileSync(localPath);
          const hash = sha1(buffer);
          const ext = inferExtFromSource(localPath);
          const filePath = path.join(EMOJI_ASSET_DIR, `${hash}${ext}`);
          if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, buffer);
          }
          return { key: `img:${hash}`, assetRef: filePath, label: "表情包" };
        }
      }
    } catch (error) {
      logger.warn("[activity] 保存表情包文件失败:", error);
    }
  }

  if (isHttpUrl(source)) {
    const hash = sha1(normalizeHttpIdentityUrl(source));
    const cachedLocal = findCachedHttpEmojiAsset(source);
    if (cachedLocal) {
      return { key: `img:${hash}`, assetRef: cachedLocal, label: "表情包" };
    }
    void downloadHttpEmojiAssetToLocal(source).catch((error) => {
      logger.debug("[activity] 表情包HTTP缓存下载失败:", error);
    });
    return { key: `img:${hash}`, assetRef: source, label: "表情包" };
  }

  const hash = sha1(source);
  return { key: `img:${hash}`, label: "表情包" };
}

function extractImageSource(segment: MessageSegment): string {
  const file = extractSegmentDataField(segment, "file");
  const pathValue = extractSegmentDataField(segment, "path");
  const url = extractSegmentDataField(segment, "url");

  if (file && (isLikelyFilePath(file) || file.startsWith("data:") || file.startsWith("base64://"))) {
    return file;
  }
  if (pathValue && (isLikelyFilePath(pathValue) || pathValue.startsWith("data:") || pathValue.startsWith("base64://"))) {
    return pathValue;
  }
  return url || file || pathValue;
}

function normalizeHttpIdentityUrl(source: string): string {
  try {
    const url = new URL(source);
    url.hash = "";

    // NTQQ 多媒体下载链接的真实身份在 fileid/appid，rkey 等参数是临时签名
    const fileId = url.searchParams.get("fileid");
    if (fileId) {
      const normalized = new URL(`${url.origin}${url.pathname}`);
      const appId = url.searchParams.get("appid");
      if (appId) normalized.searchParams.set("appid", appId);
      normalized.searchParams.set("fileid", fileId);
      return normalized.toString();
    }

    const volatileKeys = new Set([
      "rkey", "sig", "signature", "token", "auth", "authkey",
      "expires", "expire", "exp", "ts", "timestamp", "t",
    ]);
    const kept = Array.from(url.searchParams.entries())
      .filter(([key]) => !volatileKeys.has(key.toLowerCase()))
      .sort(([ka, va], [kb, vb]) => (ka === kb ? va.localeCompare(vb) : ka.localeCompare(kb)));

    url.search = "";
    for (const [key, value] of kept) {
      url.searchParams.append(key, value);
    }
    return url.toString();
  } catch {
    return source.split("?")[0]?.split("#")[0] ?? source;
  }
}

function findCachedHttpEmojiAsset(source: string): string | undefined {
  ensureDir(EMOJI_ASSET_DIR);
  const normalized = normalizeHttpIdentityUrl(source);
  const hash = sha1(normalized);
  try {
    const file = fs.readdirSync(EMOJI_ASSET_DIR).find((name) => name.startsWith(`${hash}.`));
    return file ? path.join(EMOJI_ASSET_DIR, file) : undefined;
  } catch {
    return undefined;
  }
}

async function downloadHttpEmojiAssetToLocal(source: string): Promise<string | undefined> {
  if (!isHttpUrl(source)) return undefined;

  const existing = findCachedHttpEmojiAsset(source);
  if (existing) return existing;

  const normalized = normalizeHttpIdentityUrl(source);
  const taskKey = sha1(normalized);
  const running = emojiHttpDownloadTasks.get(taskKey);
  if (running) return running;

  const task = (async () => {
    try {
      ensureDir(EMOJI_ASSET_DIR);
      const response = await fetch(source);
      if (!response.ok) return undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length <= 0) return undefined;
      const contentType = response.headers.get("content-type") ?? "";
      const ext = contentType ? extByMime(contentType) : inferExtFromSource(source);
      const filePath = path.join(EMOJI_ASSET_DIR, `${taskKey}${ext}`);
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, buffer);
      }
      return filePath;
    } catch {
      return undefined;
    } finally {
      emojiHttpDownloadTasks.delete(taskKey);
    }
  })();

  emojiHttpDownloadTasks.set(taskKey, task);
  return task;
}

function normalizeEmojiDataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeEmojiDataValue(item));
  }
  if (typeof value === "string") {
    return isHttpUrl(value) ? normalizeHttpIdentityUrl(value) : value;
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  const volatileKeys = new Set([
    "cache",
    "c",
    "download",
    "timeout",
    "time",
    "file_size",
    "size",
    "sub_type",
    "subType",
  ]);

  for (const key of Object.keys(source).sort()) {
    if (volatileKeys.has(key)) continue;
    const raw = source[key];
    if (raw === undefined || raw === null || raw === "") continue;
    normalized[key] = normalizeEmojiDataValue(raw);
  }

  return normalized;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value);
}

function extractStableImageKey(segment: MessageSegment, source: string): string | undefined {
  const data = segment.data as Record<string, unknown> | undefined;
  const candidateFields = ["file_unique", "file_id", "md5", "fid", "file_uuid", "uuid"];

  for (const field of candidateFields) {
    const value = data?.[field];
    if (typeof value === "string" && value.trim()) {
      return `img:${field}:${value.trim()}`;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return `img:${field}:${String(value)}`;
    }
  }

  const fileValue = typeof data?.file === "string" ? data.file.trim() : "";
  if (
    fileValue &&
    !isLikelyFilePath(fileValue) &&
    !isHttpUrl(fileValue) &&
    !fileValue.startsWith("data:") &&
    !fileValue.startsWith("base64://")
  ) {
    return `img:file:${fileValue}`;
  }

  const normalizedData = normalizeEmojiDataValue(data ?? {});
  const normalizedDataText = stableStringify(normalizedData);
  if (normalizedDataText && normalizedDataText !== "{}") {
    return `img:data:${sha1(normalizedDataText)}`;
  }

  if (isHttpUrl(source)) {
    return `img:url:${sha1(normalizeHttpIdentityUrl(source))}`;
  }

  return undefined;
}

function extractStableNonImageEmoji(segment: MessageSegment): { key: string; label: string } {
  const data = segment.data as Record<string, unknown> | undefined;
  const type = segment.type === "face" ? "face" : "mface";
  const candidateFields = ["id", "emoji_id", "face_id", "package_id", "tab_id", "key", "summary", "text"];

  for (const field of candidateFields) {
    const value = data?.[field];
    if (typeof value === "string" && value.trim()) {
      const labelPrefix = type === "face" ? "QQ表情" : "超级表情";
      return {
        key: `${type}:${field}:${value.trim()}`,
        label: field === "summary" || field === "text" ? value.trim() : `${labelPrefix}#${value.trim()}`,
      };
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const labelPrefix = type === "face" ? "QQ表情" : "超级表情";
      return {
        key: `${type}:${field}:${String(value)}`,
        label: `${labelPrefix}#${String(value)}`,
      };
    }
  }

  const normalizedData = normalizeEmojiDataValue(data ?? {});
  const stableText = stableStringify(normalizedData);
  const hash = sha1(stableText || type);
  return {
    key: `${type}:data:${hash}`,
    label: type === "face" ? "QQ表情" : "超级表情",
  };
}

function yyyymmddToEpochDay(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map((v) => Number(v));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return 0;
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

function isNextDate(prevDateKey: string, nextDateKey: string): boolean {
  return yyyymmddToEpochDay(nextDateKey) - yyyymmddToEpochDay(prevDateKey) === 1;
}

export class ActivityStore {
  private data: ActivityStoreData = createEmptyData();

  constructor(private readonly filePath = STORE_PATH) {
    this.load();
  }

  async ensureEmojiAssetLocal(assetRef?: string): Promise<string | undefined> {
    if (!assetRef) return undefined;
    if (!isHttpUrl(assetRef)) return assetRef;
    return (await downloadHttpEmojiAssetToLocal(assetRef)) ?? assetRef;
  }


  recordMessage(input: {
    scope: "group" | "private";
    groupId?: number;
    userId: number;
    userName?: string;
    eventTimeMs?: number;
    segments?: MessageSegment[];
  }): void {
    if (input.scope !== "group" || typeof input.groupId !== "number") {
      return;
    }

    const ts = typeof input.eventTimeMs === "number" ? input.eventTimeMs : Date.now();
    const dateKey = formatDateKeyCN(ts);
    const dayBucket = getOrCreateDailyBucket(this.data, dateKey);
    const groupStats = getOrCreateGroupDailyStats(dayBucket, input.groupId);
    const userName = normalizeUserName(input.userName, input.userId);

    groupStats.totalMessages += 1;
    incrementUserCounter(groupStats.messageUsers, input.userId, userName, 1);

    if (Array.isArray(input.segments)) {
      for (const segment of input.segments) {
        if (segment.type === "image") {
          const source = extractImageSource(segment);
          const assetSource = source || JSON.stringify(segment.data ?? {});
          const stored = persistImageAsset(assetSource);
          const stableKey = extractStableImageKey(segment, source);
          this.recordEmojiUse(groupStats, input.userId, userName, {
            key: stableKey ?? stored.key,
            label: stored.label,
            kind: "image",
            assetRef: stored.assetRef,
          });
          continue;
        }

        if (segment.type === "face" || segment.type === "mface") {
          const stable = extractStableNonImageEmoji(segment);
          this.recordEmojiUse(groupStats, input.userId, userName, {
            key: stable.key,
            label: stable.label,
            kind: segment.type,
          });
        }
      }
    }

    this.pruneOldDailyBuckets();
    this.persist();
  }

  getTodayTalkStats(groupId: number, now = Date.now()): DailyTalkStatsResult {
    const dateKey = formatDateKeyCN(now);
    const groupStats = this.data.daily[dateKey]?.groups?.[String(groupId)];
    const totalCount = groupStats?.totalMessages ?? 0;
    const users = Object.entries(groupStats?.messageUsers ?? {}).map(([userId, info]) => ({
      userId: Number(userId),
      userName: info.name,
      count: info.count,
    }));
    users.sort((a, b) => b.count - a.count || a.userId - b.userId);
    const top = users.slice(0, 10).map((item) => ({
      ...item,
      percent: totalCount > 0 ? item.count / totalCount : 0,
    }));
    return {
      titleDateKey: dateKey,
      generatedAtMs: now,
      groupId,
      items: top,
      totalCount,
      participantCount: users.length,
    };
  }

  getTodayEmojiStats(groupId: number, now = Date.now()): DailyEmojiStatsResult {
    const dateKey = formatDateKeyCN(now);
    const groupStats = this.data.daily[dateKey]?.groups?.[String(groupId)];
    const totalCount = groupStats?.totalEmojiUses ?? 0;
    const users = Object.entries(groupStats?.emojiUsers ?? {}).map(([userId, info]) => ({
      userId: Number(userId),
      userName: info.name,
      count: info.count,
    }));
    users.sort((a, b) => b.count - a.count || a.userId - b.userId);
    return {
      titleDateKey: dateKey,
      generatedAtMs: now,
      groupId,
      items: users.slice(0, 10).map((item) => ({
        ...item,
        percent: totalCount > 0 ? item.count / totalCount : 0,
      })),
      totalCount,
      participantCount: users.length,
    };
  }

  getTodayTopEmojis(groupId: number, now = Date.now(), limit = 3): TopEmojiItem[] {
    const dateKey = formatDateKeyCN(now);
    const groupStats = this.data.daily[dateKey]?.groups?.[String(groupId)];
    const merged = new Map<string, EmojiCounter>();
    for (const item of Object.values(groupStats?.emojis ?? {})) {
      let mergeKey = item.key;
      if (item.kind === "image" && item.assetRef) {
        mergeKey = isHttpUrl(item.assetRef)
          ? `img:merged:${normalizeHttpIdentityUrl(item.assetRef)}`
          : `img:merged:${item.assetRef}`;
      }
      const current = merged.get(mergeKey);
      if (!current) {
        merged.set(mergeKey, { ...item });
        continue;
      }
      current.count += item.count;
      if (!current.assetRef && item.assetRef) current.assetRef = item.assetRef;
      if ((!current.label || current.label === "表情包") && item.label) current.label = item.label;
    }

    const sorted = Array.from(merged.values()).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    const preferred = sorted.filter((item) => item.kind === "image");
    const fallback = sorted.filter((item) => item.kind !== "image");
    const picked = [...preferred, ...fallback].slice(0, Math.max(0, Math.floor(limit)));
    return picked.map((item) => ({
      key: item.key,
      label: item.label,
      count: item.count,
      kind: item.kind,
      assetRef: item.assetRef,
    }));
  }

  getTotalPointsRanking(now = Date.now()): TotalPointsRankResult {
    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const users = Object.entries(globalBucket.profiles ?? {})
      .map(([userIdKey, profile]) => {
        const record = profile as Partial<SignInUserRecord> | undefined;
        const parsedUserId =
          typeof record?.userId === "number" && Number.isFinite(record.userId)
            ? Math.floor(record.userId)
            : Number(userIdKey);
        const safeUserId = Number.isFinite(parsedUserId) && parsedUserId > 0 ? parsedUserId : 0;
        const totalPoints =
          typeof record?.totalPoints === "number" && Number.isFinite(record.totalPoints)
            ? Math.max(0, Math.floor(record.totalPoints))
            : 0;
        const userName = normalizeUserName(typeof record?.userName === "string" ? record.userName : undefined, safeUserId || 0);
        return {
          userId: safeUserId,
          userName,
          count: totalPoints,
        };
      })
      .filter((item) => item.userId > 0 && item.count > 0);

    users.sort((a, b) => b.count - a.count || a.userId - b.userId);
    const totalPoints = users.reduce((sum, item) => sum + item.count, 0);
    const items = users.slice(0, 10).map((item) => ({
      userId: item.userId,
      userName: item.userName,
      count: item.count,
      percent: totalPoints > 0 ? item.count / totalPoints : 0,
    }));

    return {
      generatedAtMs: now,
      items,
      totalPoints,
      participantCount: users.length,
    };
  }

  addUserPoints(input: {
    userId: number;
    points: number;
    userName?: string;
    now?: number;
  }): RechargePointsResult {
    const userId = Math.floor(input.userId);
    const points = Math.floor(input.points);
    if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(points) || points <= 0) {
      throw new Error("invalid recharge params");
    }

    const userKey = String(userId);
    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const existingProfile = globalBucket.profiles[userKey] as Partial<SignInUserRecord> | undefined;
    const userName =
      (typeof input.userName === "string" && input.userName.trim()) ||
      (typeof existingProfile?.userName === "string" && existingProfile.userName.trim()) ||
      `用户${userId}`;
    const profile = normalizeSignInProfile(
      existingProfile,
      userId,
      userName,
    );

    profile.userName = userName;
    profile.totalPoints += points;
    globalBucket.profiles[userKey] = profile;
    this.persist();

    return {
      userId,
      userName: profile.userName,
      addedPoints: points,
      totalPoints: profile.totalPoints,
      operatedAtMs:
        typeof input.now === "number" && Number.isFinite(input.now) && input.now > 0
          ? Math.floor(input.now)
          : Date.now(),
    };
  }

  getUserPoints(input: { userId: number; userName?: string }): UserPointsSnapshot {
    const userId = Math.floor(input.userId);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new Error("invalid user id");
    }

    const userKey = String(userId);
    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const existingProfile = globalBucket.profiles[userKey] as Partial<SignInUserRecord> | undefined;
    const userName =
      (typeof input.userName === "string" && input.userName.trim()) ||
      (typeof existingProfile?.userName === "string" && existingProfile.userName.trim()) ||
      `用户${userId}`;
    const totalPoints =
      typeof existingProfile?.totalPoints === "number" && Number.isFinite(existingProfile.totalPoints)
        ? Math.max(0, Math.floor(existingProfile.totalPoints))
        : 0;

    return {
      userId,
      userName,
      totalPoints,
    };
  }

  spendUserPoints(input: {
    userId: number;
    points: number;
    userName?: string;
  }): UserPointsSnapshot & { spentPoints: number } {
    const userId = Math.floor(input.userId);
    const points = Math.floor(input.points);
    if (!Number.isFinite(userId) || userId <= 0 || !Number.isFinite(points) || points <= 0) {
      throw new Error("invalid spend params");
    }

    const userKey = String(userId);
    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const existingProfile = globalBucket.profiles[userKey] as Partial<SignInUserRecord> | undefined;
    const userName =
      (typeof input.userName === "string" && input.userName.trim()) ||
      (typeof existingProfile?.userName === "string" && existingProfile.userName.trim()) ||
      `用户${userId}`;
    const profile = normalizeSignInProfile(existingProfile, userId, userName);

    if (profile.totalPoints < points) {
      throw new Error("insufficient points");
    }

    profile.userName = userName;
    profile.totalPoints -= points;
    globalBucket.profiles[userKey] = profile;
    this.persist();

    return {
      userId,
      userName: profile.userName,
      totalPoints: profile.totalPoints,
      spentPoints: points,
    };
  }

  transferUserPoints(input: {
    fromUserId: number;
    toUserId: number;
    points: number;
    fromUserName?: string;
    toUserName?: string;
    now?: number;
  }): TransferPointsResult {
    const fromUserId = Math.floor(input.fromUserId);
    const toUserId = Math.floor(input.toUserId);
    const points = Math.floor(input.points);
    if (
      !Number.isFinite(fromUserId) ||
      fromUserId <= 0 ||
      !Number.isFinite(toUserId) ||
      toUserId <= 0 ||
      !Number.isFinite(points) ||
      points <= 0 ||
      fromUserId === toUserId
    ) {
      throw new Error("invalid transfer params");
    }

    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const fromKey = String(fromUserId);
    const toKey = String(toUserId);
    const fromExistingProfile = globalBucket.profiles[fromKey] as Partial<SignInUserRecord> | undefined;
    const toExistingProfile = globalBucket.profiles[toKey] as Partial<SignInUserRecord> | undefined;
    const fromUserName =
      (typeof input.fromUserName === "string" && input.fromUserName.trim()) ||
      (typeof fromExistingProfile?.userName === "string" && fromExistingProfile.userName.trim()) ||
      `用户${fromUserId}`;
    const toUserName =
      (typeof input.toUserName === "string" && input.toUserName.trim()) ||
      (typeof toExistingProfile?.userName === "string" && toExistingProfile.userName.trim()) ||
      `用户${toUserId}`;
    const fromProfile = normalizeSignInProfile(fromExistingProfile, fromUserId, fromUserName);
    const toProfile = normalizeSignInProfile(toExistingProfile, toUserId, toUserName);

    if (fromProfile.totalPoints < points) {
      throw new Error("insufficient points");
    }

    fromProfile.userName = fromUserName;
    toProfile.userName = toUserName;
    fromProfile.totalPoints -= points;
    toProfile.totalPoints += points;
    globalBucket.profiles[fromKey] = fromProfile;
    globalBucket.profiles[toKey] = toProfile;
    this.persist();

    return {
      fromUserId,
      fromUserName: fromProfile.userName,
      toUserId,
      toUserName: toProfile.userName,
      transferredPoints: points,
      fromTotalPoints: fromProfile.totalPoints,
      toTotalPoints: toProfile.totalPoints,
      operatedAtMs:
        typeof input.now === "number" && Number.isFinite(input.now) && input.now > 0
          ? Math.floor(input.now)
          : Date.now(),
    };
  }

  signIn(input: {
    scope: "group" | "private";
    scopeId: number;
    userId: number;
    userName?: string;
    now?: number;
  }): SignInResult {
    const now = typeof input.now === "number" ? input.now : Date.now();
    const dateKey = formatDateKeyCN(now);
    const userKey = String(input.userId);
    const userName = normalizeUserName(input.userName, input.userId);

    const globalBucket = getOrCreateGlobalSignInBucket(this.data);
    const globalDayBucket = getOrCreateGlobalSignInDayBucket(globalBucket, dateKey);
    const existingToday = globalDayBucket.users[userKey];

    const profile = normalizeSignInProfile(
      globalBucket.profiles[userKey] as Partial<SignInUserRecord> | undefined,
      input.userId,
      userName,
    );
    profile.userName = userName;
    globalBucket.profiles[userKey] = profile;

    if (existingToday) {
      this.persist();
      return {
        scope: input.scope,
        scopeId: input.scopeId,
        userId: input.userId,
        userName,
        dateKey,
        signedAtMs: existingToday.signedAt,
        status: "already_signed",
        seqToday: existingToday.seq,
        todayTotal: globalDayBucket.count,
        totalDays: profile.totalDays,
        streakDays: profile.streakDays,
        totalPoints: profile.totalPoints,
        rewardPoints: 0,
      };
    }

    const rewardPoints = randomSignInRewardPoints();
    profile.totalDays += 1;
    profile.streakDays = profile.lastDateKey && isNextDate(profile.lastDateKey, dateKey)
      ? profile.streakDays + 1
      : 1;
    profile.lastDateKey = dateKey;
    profile.totalPoints += rewardPoints;
    globalBucket.profiles[userKey] = profile;

    globalDayBucket.count += 1;
    globalDayBucket.users[userKey] = {
      userName,
      signedAt: now,
      seq: globalDayBucket.count,
      rewardPoints,
    };

    this.pruneOldGlobalSignInDays(globalBucket);
    this.persist();

    return {
      scope: input.scope,
      scopeId: input.scopeId,
      userId: input.userId,
      userName,
      dateKey,
      signedAtMs: now,
      status: "signed",
      seqToday: globalDayBucket.count,
      todayTotal: globalDayBucket.count,
      totalDays: profile.totalDays,
      streakDays: profile.streakDays,
      totalPoints: profile.totalPoints,
      rewardPoints,
    };
  }

  private recordEmojiUse(
    groupStats: GroupDailyStats,
    userId: number,
    userName: string,
    item: { key: string; label: string; kind: "image" | "face" | "mface"; assetRef?: string },
  ): void {
    groupStats.totalEmojiUses += 1;
    incrementUserCounter(groupStats.emojiUsers, userId, userName, 1);

    const current = groupStats.emojis[item.key];
    if (!current) {
      groupStats.emojis[item.key] = {
        key: item.key,
        label: item.label,
        count: 1,
        kind: item.kind,
        assetRef: item.assetRef,
      };
      return;
    }
    current.count += 1;
    current.label = item.label || current.label;
    if (item.assetRef) {
      current.assetRef = item.assetRef;
    }
  }

  private pruneOldDailyBuckets(): void {
    const keys = Object.keys(this.data.daily).sort();
    if (keys.length <= MAX_DAILY_BUCKETS) return;
    for (const key of keys.slice(0, keys.length - MAX_DAILY_BUCKETS)) {
      delete this.data.daily[key];
    }
  }

  private pruneOldSignInDays(bucket: GroupSignInBucket): void {
    const keys = Object.keys(bucket.days).sort();
    if (keys.length <= MAX_DAILY_BUCKETS) return;
    for (const key of keys.slice(0, keys.length - MAX_DAILY_BUCKETS)) {
      delete bucket.days[key];
    }
  }

  private pruneOldGlobalSignInDays(bucket: SignInGlobalBucket): void {
    const keys = Object.keys(bucket.days).sort();
    if (keys.length <= MAX_DAILY_BUCKETS) return;
    for (const key of keys.slice(0, keys.length - MAX_DAILY_BUCKETS)) {
      delete bucket.days[key];
    }
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      this.data = createEmptyData();
      this.persist();
      return;
    }
    try {
      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const record = normalizeRecord<Record<string, unknown>>(parsed, {});
      this.data = {
        version: CURRENT_VERSION,
        daily: normalizeRecord(record.daily, {}),
        signIn: normalizeRecord(record.signIn, { groups: {}, privates: {}, global: { profiles: {}, days: {} } }),
      };
      if (!this.data.signIn.groups) this.data.signIn.groups = {};
      if (!this.data.signIn.privates) this.data.signIn.privates = {};
      if (!(this.data.signIn as { global?: SignInGlobalBucket }).global) {
        (this.data.signIn as { global: SignInGlobalBucket }).global = { profiles: {}, days: {} };
      }
      this.pruneOldDailyBuckets();
      this.persist();
    } catch (error) {
      logger.warn("[activity] 统计存储读取失败，已重置:", error);
      this.data = createEmptyData();
      this.persist();
    }
  }

  private persist(): void {
    ensureDir(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    if (fs.existsSync(this.filePath)) {
      fs.rmSync(this.filePath, { force: true });
    }
    fs.renameSync(tmp, this.filePath);
  }
}

export const activityStore = new ActivityStore();


