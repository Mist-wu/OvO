import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logger } from "../../../utils/logger";
import { activityStore, renderPointsRankingCard, renderSignInCard } from "../../../activity";
import { generateGeminiImageWithInputs, type GeminiGeneratedImage, type GeminiInlineImage } from "../../../llm";
import { ExternalCallError } from "../../../utils/external_call";
import { fetchWeatherSummary } from "../../../utils/weather";
import { buildMessage, image as imageSegment, type MessageSegment } from "../../message";
import type { CommandDefinition, CommandExecutionContext } from "../types";

type EmptyPayload = Record<string, never>;
type HelpScope = "root" | "user";
type HelpTextProvider = (scope: HelpScope) => string;

const emptyPayload: EmptyPayload = {};
const IMAGE_COST_POINTS = 6;
const GENERATED_IMAGE_DIR = path.resolve(process.cwd(), "data/generated_images");
const DRAW_REFERENCE_IMAGE_LIMIT = 6;
const DRAW_AVATAR_CACHE_DIR = path.resolve(process.cwd(), "data/qq_avatars");
const DRAW_DIRECT_BASE64_MAX_BYTES = 3 * 1024 * 1024;

function defineCommand<Payload>(
  definition: CommandDefinition<Payload>,
): CommandDefinition<unknown> {
  return definition as CommandDefinition<unknown>;
}

async function sendContextImage(
  context: CommandExecutionContext,
  imageFile: string,
): Promise<void> {
  const message = buildMessage(imageSegment(imageFile));
  if (context.messageType === "group" && typeof context.groupId === "number") {
    await context.client.sendMessage({ groupId: context.groupId, message });
    return;
  }
  await context.client.sendMessage({ userId: context.userId, message });
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function imageExtByMime(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return ".jpg";
  if (normalized === "image/webp") return ".webp";
  if (normalized === "image/gif") return ".gif";
  if (normalized === "image/bmp") return ".bmp";
  return ".png";
}

function persistGeneratedImage(dataBase64: string, mimeType: string): string {
  ensureDir(GENERATED_IMAGE_DIR);
  const buffer = Buffer.from(dataBase64, "base64");
  const ext = imageExtByMime(mimeType);
  const filePath = path.join(GENERATED_IMAGE_DIR, `gemini_${Date.now()}_${Math.random().toString(16).slice(2, 8)}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function estimateBytesFromBase64(dataBase64: string): number {
  const normalized = dataBase64.replace(/\s+/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function toBase64PseudoUri(dataBase64: string): string {
  return `base64://${dataBase64.replace(/\s+/g, "")}`;
}

async function sendGeneratedImage(context: CommandExecutionContext, generated: GeminiGeneratedImage): Promise<void> {
  const payloadBytes = estimateBytesFromBase64(generated.dataBase64);
  if (payloadBytes > 0 && payloadBytes <= DRAW_DIRECT_BASE64_MAX_BYTES) {
    try {
      await sendContextImage(context, toBase64PseudoUri(generated.dataBase64));
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (isSendMessageTimeoutError(message)) {
        // 发送超时类错误可能是“服务端已投递但回包超时”，避免回退再发导致重复图片
        throw error;
      }
      logger.warn("[draw] base64 直发失败，回退文件发送:", error);
    }
  }

  const imageFile = persistGeneratedImage(generated.dataBase64, generated.mimeType);
  await sendContextImage(context, imageFile);
}

function parseCqParams(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (!key) continue;
    result[key.trim()] = rest.join("=").trim();
  }
  return result;
}

function parseRawCqSegments(raw: string): MessageSegment[] {
  const regex = /\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]+))?\]/g;
  const segments: MessageSegment[] = [];
  for (const match of raw.matchAll(regex)) {
    const type = (match[1] ?? "").toLowerCase();
    const params = parseCqParams(match[2]);
    if (!type) continue;
    segments.push({
      type,
      data: params as Record<string, unknown>,
    });
  }
  return segments;
}

function extractSegmentsFromUnknownMessage(message: unknown): MessageSegment[] {
  if (Array.isArray(message)) {
    return message as MessageSegment[];
  }
  if (message && typeof message === "object" && "type" in message && "data" in message) {
    return [message as MessageSegment];
  }
  if (typeof message === "string" && message.trim()) {
    return parseRawCqSegments(message);
  }
  return [];
}

function getReplyMessageIdFromSegments(segments: MessageSegment[] | undefined): number | string | undefined {
  if (!Array.isArray(segments)) return undefined;
  for (const segment of segments) {
    if (segment.type !== "reply") continue;
    const id = segment.data?.id;
    if (typeof id === "number" || typeof id === "string") {
      return id;
    }
  }
  return undefined;
}

function extractSegmentString(segment: MessageSegment, key: string): string {
  const value = (segment.data as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isLocalPath(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("file://")) return true;
  if (/^[a-zA-Z]:\\/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  return false;
}

function toLocalPath(value: string): string {
  return value.startsWith("file://") ? fileURLToPath(value) : value;
}

function imageMimeByExt(value: string): string {
  const ext = path.extname(value.split("?")[0]).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".bmp") return "image/bmp";
  return "image/png";
}

function pickImageSourceFromSegment(segment: MessageSegment): string | undefined {
  if (segment.type !== "image") return undefined;
  const file = extractSegmentString(segment, "file");
  const url = extractSegmentString(segment, "url");
  const pathValue = extractSegmentString(segment, "path");
  if (url) return url;
  if (pathValue) return pathValue;
  if (file) return file;
  return undefined;
}

function parseDataUriImage(source: string): GeminiInlineImage | undefined {
  const matched = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/i);
  if (!matched) return undefined;
  return {
    mimeType: matched[1].toLowerCase(),
    dataBase64: matched[2],
  };
}

function parseBase64PseudoUriImage(source: string): GeminiInlineImage | undefined {
  if (!source.startsWith("base64://")) return undefined;
  return {
    mimeType: "image/jpeg",
    dataBase64: source.slice("base64://".length),
  };
}

async function readInlineImageFromSource(source: string): Promise<GeminiInlineImage | undefined> {
  const trimmed = source.trim();
  if (!trimmed) return undefined;

  const fromDataUri = parseDataUriImage(trimmed);
  if (fromDataUri) return fromDataUri;

  const fromPseudo = parseBase64PseudoUriImage(trimmed);
  if (fromPseudo) return fromPseudo;

  if (isLocalPath(trimmed)) {
    try {
      const filePath = toLocalPath(trimmed);
      if (!fs.existsSync(filePath)) return undefined;
      const buffer = fs.readFileSync(filePath);
      if (buffer.length <= 0) return undefined;
      return {
        mimeType: imageMimeByExt(filePath),
        dataBase64: buffer.toString("base64"),
      };
    } catch (error) {
      logger.debug("[draw] 读取本地参考图失败:", error);
      return undefined;
    }
  }

  if (isHttpUrl(trimmed)) {
    try {
      const response = await fetch(trimmed);
      if (!response.ok) return undefined;
      const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (contentType && !contentType.startsWith("image/")) return undefined;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length <= 0) return undefined;
      return {
        mimeType: contentType || imageMimeByExt(trimmed),
        dataBase64: buffer.toString("base64"),
      };
    } catch (error) {
      logger.debug("[draw] 下载参考图失败:", error);
      return undefined;
    }
  }

  return undefined;
}

function extractAtUserIdsFromSegments(
  segments: MessageSegment[] | undefined,
  options?: { selfId?: number | string },
): number[] {
  if (!Array.isArray(segments)) return [];
  const selfIdText =
    typeof options?.selfId === "number" || typeof options?.selfId === "string" ? String(options.selfId) : "";
  const ids = new Set<number>();
  for (const segment of segments) {
    if (segment.type !== "at") continue;
    const qq = segment.data?.qq;
    if (qq === "all") continue;
    const qqText = typeof qq === "number" || typeof qq === "string" ? String(qq).trim() : "";
    if (!qqText) continue;
    if (selfIdText && qqText === selfIdText) continue;
    const parsed = Number(qqText);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    ids.add(Math.floor(parsed));
  }
  return Array.from(ids);
}

type DrawReferenceSource = {
  source: string;
  label: string;
};

type GetMsgData = {
  message?: unknown;
  raw_message?: unknown;
};

async function resolveReplyImageSources(context: CommandExecutionContext): Promise<DrawReferenceSource[]> {
  const segments = Array.isArray(context.event.message) ? (context.event.message as MessageSegment[]) : undefined;
  const replyId = getReplyMessageIdFromSegments(segments);
  if (replyId === undefined) return [];

  try {
    const response = await context.client.getMsg(replyId);
    const data = response.data as GetMsgData | undefined;
    let replySegments = extractSegmentsFromUnknownMessage(data?.message);
    if (replySegments.length <= 0 && typeof data?.raw_message === "string") {
      replySegments = parseRawCqSegments(data.raw_message);
    }
    return replySegments
      .map((segment) => pickImageSourceFromSegment(segment))
      .filter((item): item is string => Boolean(item))
      .map((source, index) => ({ source, label: index === 0 ? "引用图片" : `引用图片${index + 1}` }));
  } catch (error) {
    logger.warn("[draw] 获取引用消息图片失败:", error);
    return [];
  }
}

async function ensureQqAvatarLocalFile(userId: number): Promise<string | undefined> {
  ensureDir(DRAW_AVATAR_CACHE_DIR);
  const existing = fs
    .readdirSync(DRAW_AVATAR_CACHE_DIR)
    .find((name) => name.startsWith(`${userId}.`));
  if (existing) {
    return path.join(DRAW_AVATAR_CACHE_DIR, existing);
  }

  try {
    const url = `https://q1.qlogo.cn/g?b=qq&nk=${userId}&s=640`;
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (contentType && !contentType.startsWith("image/")) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0) return undefined;
    const ext = imageExtByMime(contentType || "image/jpeg");
    const filePath = path.join(DRAW_AVATAR_CACHE_DIR, `${userId}${ext}`);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (error) {
    logger.debug("[draw] 下载QQ头像失败:", error);
    return undefined;
  }
}

function pickDisplayNameFromUnknown(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const record = data as { card?: unknown; nickname?: unknown };
  if (typeof record.card === "string" && record.card.trim()) return record.card.trim();
  if (typeof record.nickname === "string" && record.nickname.trim()) return record.nickname.trim();
  return undefined;
}

async function resolveMentionDisplayName(
  context: CommandExecutionContext,
  userId: number,
): Promise<string | undefined> {
  if (typeof context.groupId === "number") {
    try {
      const response = await context.client.sendAction("get_group_member_info", {
        group_id: context.groupId,
        user_id: userId,
        no_cache: false,
      });
      const name = pickDisplayNameFromUnknown(response.data);
      if (name) return name;
    } catch (error) {
      logger.debug("[draw] 获取群成员昵称失败:", error);
    }
  }

  try {
    const response = await context.client.sendAction("get_stranger_info", {
      user_id: userId,
      no_cache: false,
    });
    return pickDisplayNameFromUnknown(response.data);
  } catch (error) {
    logger.debug("[draw] 获取用户昵称失败:", error);
    return undefined;
  }
}

async function collectDrawReferenceImages(
  context: CommandExecutionContext,
): Promise<{ inlineImages: GeminiInlineImage[]; labels: string[] }> {
  const currentSegments = Array.isArray(context.event.message) ? (context.event.message as MessageSegment[]) : [];
  const currentMessageImages = currentSegments
    .map((segment) => pickImageSourceFromSegment(segment))
    .filter((item): item is string => Boolean(item))
    .map((source, index) => ({ source, label: index === 0 ? "本条图片" : `本条图片${index + 1}` }));

  const replyImages = await resolveReplyImageSources(context);
  const atUserIds = extractAtUserIdsFromSegments(currentSegments, { selfId: context.event.self_id });
  const avatarRefs = (
    await Promise.all(
      atUserIds.map(async (qq) => {
        const localPath = await ensureQqAvatarLocalFile(qq);
        if (!localPath) return undefined;
        const displayName = await resolveMentionDisplayName(context, qq);
        const label = `${displayName || `@${qq}`}头像`;
        return { source: localPath, label } satisfies DrawReferenceSource;
      }),
    )
  ).filter((item): item is DrawReferenceSource => Boolean(item));

  const mergedSources = [...replyImages, ...currentMessageImages, ...avatarRefs];
  const dedupe = new Set<string>();
  const inlineImages: GeminiInlineImage[] = [];
  const labels: string[] = [];

  for (const item of mergedSources) {
    if (inlineImages.length >= DRAW_REFERENCE_IMAGE_LIMIT) break;
    const key = item.source.trim();
    if (!key || dedupe.has(key)) continue;
    dedupe.add(key);
    const inline = await readInlineImageFromSource(item.source);
    if (!inline) continue;
    inlineImages.push(inline);
    labels.push(item.label);
  }

  return { inlineImages, labels };
}

function isSendMessageTimeoutError(message: string): boolean {
  const normalized = message.toLowerCase();
  const isSendMessageAction =
    normalized.includes("action=send_group_msg") || normalized.includes("action=send_private_msg");
  if (!isSendMessageAction) return false;
  return normalized.includes("timeout") || normalized.includes("retcode=1200");
}

function isGeminiImageTimeoutError(error: unknown): boolean {
  if (!(error instanceof ExternalCallError)) return false;
  if (error.service !== "gemini" || error.operation !== "generate_image") return false;
  if (error.reason === "circuit_open" || error.retryable) return true;
  const causeMessage = error.cause instanceof Error ? error.cause.message.toLowerCase() : "";
  return causeMessage.includes("timeout") || causeMessage.includes("timed out");
}

export function createUserCommands(getHelpText: HelpTextProvider): CommandDefinition<unknown>[] {
  return [
    defineCommand({
      name: "user_help",
      access: "user",
      help: "/帮助",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/帮助" ? emptyPayload : null;
      },
      async execute(context) {
        await context.sendText(getHelpText("user"));
      },
    }),
    defineCommand({
      name: "sign_in",
      access: "user",
      help: "/签到",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/签到" ? emptyPayload : null;
      },
      async execute(context) {
        const isGroup = context.messageType === "group" && typeof context.groupId === "number";
        const result = activityStore.signIn({
          scope: isGroup ? "group" : "private",
          scopeId: isGroup ? context.groupId! : context.userId,
          userId: context.userId,
          userName: getSenderNameFromEvent(context.event),
          now:
            typeof context.event.time === "number" && Number.isFinite(context.event.time) && context.event.time > 0
              ? Math.floor(context.event.time * 1000)
              : Date.now(),
        });
        const imageFile = await renderSignInCard(result);
        await sendContextImage(context, imageFile);
      },
    }),
    defineCommand({
      name: "points_ranking",
      access: "user",
      help: "/积分排行榜",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/积分排行榜" ? emptyPayload : null;
      },
      async execute(context) {
        const now =
          typeof context.event.time === "number" && Number.isFinite(context.event.time) && context.event.time > 0
            ? Math.floor(context.event.time * 1000)
            : Date.now();
        const stats = activityStore.getTotalPointsRanking(now);
        const imageFile = await renderPointsRankingCard(stats);
        await sendContextImage(context, imageFile);
      },
    }),
    defineCommand({
      name: "draw_image",
      access: "user",
      help: "/图 <关键词...>",
      parse(message) {
        const matched = message.trim().match(/^\/图(?:\s+(.+))?$/);
        if (!matched) return null;
        return { keywords: matched[1]?.trim() || "" };
      },
      async execute(context, payload) {
        const keywords = (payload as { keywords?: string }).keywords?.trim() || "";
        if (!keywords) {
          await context.sendText("用法：/图 <关键词...>");
          return;
        }

        const senderName = getSenderNameFromEvent(context.event);
        const pointsSnapshot = activityStore.getUserPoints({
          userId: context.userId,
          userName: senderName,
        });

        if (pointsSnapshot.totalPoints < IMAGE_COST_POINTS) {
          await context.sendText(
            `积分不足，生成图片需要 ${IMAGE_COST_POINTS} 积分，当前剩余 ${pointsSnapshot.totalPoints} 积分`,
          );
          return;
        }

        await context.sendText(
          `图片生成中，请稍候...\n将消耗 ${IMAGE_COST_POINTS} 积分（当前 ${pointsSnapshot.totalPoints} 积分）`,
        );

        try {
          const references = await collectDrawReferenceImages(context);
          if (references.labels.length > 0) {
            await context.sendText(`已识别参考图：${references.labels.join("、")}`);
          }

          const generated = await generateGeminiImageWithInputs({
            prompt: keywords,
            inlineImages: references.inlineImages,
          });
          await sendGeneratedImage(context, generated);

          const spent = activityStore.spendUserPoints({
            userId: context.userId,
            points: IMAGE_COST_POINTS,
            userName: senderName,
          });
          await context.sendText(`已扣除 ${spent.spentPoints} 积分，剩余 ${spent.totalPoints} 积分`);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (isSendMessageTimeoutError(message)) {
            logger.warn("[draw] /图 图片发送回包超时，可能稍后到达:", error);
            return;
          }
          if (
            isGeminiImageTimeoutError(error) ||
            message.includes("aborted service=gemini operation=generate_image")
          ) {
            logger.warn("[draw] /图 超时或线路拥堵，未扣积分:", error);
            await context.sendText("生图超时，未扣除积分，请稍后重试（可尝试减少关键词）");
            return;
          }

          logger.warn("[draw] /图 失败:", error);
          if (message.includes("insufficient points")) {
            await context.sendText("积分不足，图片已生成但扣费时余额不足，请稍后重试");
            return;
          }
          if (message.includes("GEMINI_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("生图失败，未扣除积分，请稍后再试");
        }
      },
    }),
    defineCommand({
      name: "weather",
      access: "user",
      help: "/天气 <城市>",
      parse(message) {
        const matched = message.trim().match(/^\/天气(?:\s+(.+))?$/);
        if (!matched) return null;
        return { location: matched[1]?.trim() || "" };
      },
      async execute(context, payload) {
        const location = (payload as { location?: string }).location || "";
        if (!location) {
          await context.sendText("用法：/天气 <城市>");
          return;
        }

        try {
          const report = await fetchWeatherSummary(location);
          await context.sendText(report);
        } catch (error) {
          logger.warn("[weather] 查询失败:", error);
          const message = error instanceof Error ? error.message : "";
          if (message.includes("WEATHER_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("天气查询失败，请稍后重试");
        }
      },
    }),
  ];
}

function getSenderNameFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const sender = (event as { sender?: unknown }).sender;
  if (!sender || typeof sender !== "object") return undefined;
  const record = sender as { card?: unknown; nickname?: unknown };
  if (typeof record.card === "string" && record.card.trim()) return record.card.trim();
  if (typeof record.nickname === "string" && record.nickname.trim()) return record.nickname.trim();
  return undefined;
}

