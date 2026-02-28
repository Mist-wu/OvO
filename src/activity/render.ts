import fs from "node:fs";
import path from "node:path";

import { createCanvas, GlobalFonts, loadImage, type CanvasRenderingContext2D } from "@napi-rs/canvas";
import { logger } from "../utils/logger";

import type {
  DailyEmojiStatsResult,
  DailyTalkStatsResult,
  TotalPointsRankResult,
  RechargePointsResult,
  TransferPointsResult,
  SignInResult,
  TopEmojiItem,
} from "./store";

const OUTPUT_DIR = path.resolve(process.cwd(), "data/render_cards");
const AVATAR_DIR = path.resolve(process.cwd(), "data/qq_avatars");
const EMBEDDED_FONT_DIR = path.resolve(process.cwd(), "assert/fonts");
const EMBEDDED_TEXT_FONT_PATHS = [
  "NotoSans-Regular.ttf",
  "NotoSansMono-Regular.ttf",
].map((name) => path.join(EMBEDDED_FONT_DIR, name));
const EMBEDDED_EMOJI_FONT_PATHS = [
  "NotoColorEmoji-Regular.ttf",
  "NotoColorEmoji.ttf",
].map((name) => path.join(EMBEDDED_FONT_DIR, name));
const EMBEDDED_TEXT_FONT_FAMILY = "OvO Text";
const EMBEDDED_EMOJI_FONT_FAMILY = "OvO Emoji";
const EMBEDDED_CJK_FALLBACK_FONT_FAMILY = "OvO CJK Fallback";
const EMBEDDED_SYMBOL_FALLBACK_FONT_FAMILY = "OvO Symbol Fallback";
const SYSTEM_TEXT_FALLBACK_FAMILIES = [
  "Noto Sans",
  "Microsoft YaHei",
  "PingFang SC",
  "DejaVu Sans",
];
const SYSTEM_EMOJI_FALLBACK_FAMILIES = [
  "Noto Color Emoji",
  "Apple Color Emoji",
  "Segoe UI Emoji",
  "Twemoji Mozilla",
];
const SYSTEM_CJK_FALLBACK_FAMILIES = [
  "Noto Sans CJK SC",
  "Noto Sans SC",
  "Source Han Sans CN",
  "WenQuanYi Micro Hei",
  "Microsoft YaHei",
  "PingFang SC",
  "SimHei",
];
const SYSTEM_SYMBOL_FALLBACK_FAMILIES = [
  "Noto Sans Symbols 2",
  "Noto Sans Symbols",
  "Segoe UI Symbol",
  "Symbola",
  "DejaVu Sans",
];
const EMBEDDED_CJK_FALLBACK_PATHS = [
  "NotoSansSC-Regular.ttf",
  "NotoSansCJKsc-Regular.otf",
  "NotoSansCJKsc-Regular.ttc",
  "NotoSansCJK-Regular.otf",
  "NotoSansCJK-Regular.ttc",
  "Noto Sans CJK Regular.otf",
  "SourceHanSansCN-Regular.otf",
  "WenQuanYiMicroHei.ttf",
  "ZCOOLKuaiLe-Regular.ttf",
].map((name) => path.join(EMBEDDED_FONT_DIR, name));
const EMBEDDED_SYMBOL_FALLBACK_PATHS = [
  "NotoSansSymbols2-Regular.ttf",
  "STIX2Math.otf",
  "NotoSansSymbols-Regular.ttf",
  "Symbola.ttf",
  "DejaVuSans.ttf",
].map((name) => path.join(EMBEDDED_FONT_DIR, name));

let renderFontsInitialized = false;

function hasAnySystemFontFamily(candidates: string[]): boolean {
  return candidates.some((family) => GlobalFonts.has(family));
}

function registerAvailableFonts(family: string, candidates: string[]): string[] {
  const registered: string[] = [];
  for (const fontPath of candidates) {
    if (!fs.existsSync(fontPath)) continue;
    if (GlobalFonts.registerFromPath(fontPath, family)) {
      registered.push(fontPath);
    }
  }
  return registered;
}

function ensureRenderFonts(): void {
  if (renderFontsInitialized) return;
  renderFontsInitialized = true;

  const text = registerAvailableFonts(EMBEDDED_TEXT_FONT_FAMILY, EMBEDDED_TEXT_FONT_PATHS);
  if (text.length <= 0 && !hasAnySystemFontFamily(SYSTEM_TEXT_FALLBACK_FAMILIES)) {
    logger.warn(
      `[activity] 未找到主字体，建议添加到 assert/fonts: ${EMBEDDED_TEXT_FONT_PATHS.map((item) => path.basename(item)).join(" / ")}`,
    );
  }
  const symbol = registerAvailableFonts(EMBEDDED_SYMBOL_FALLBACK_FONT_FAMILY, EMBEDDED_SYMBOL_FALLBACK_PATHS);
  if (symbol.length <= 0 && !hasAnySystemFontFamily(SYSTEM_SYMBOL_FALLBACK_FAMILIES)) {
    logger.warn(`[activity] 未在 assert/fonts 找到符号兜底字体，建议添加: ${EMBEDDED_SYMBOL_FALLBACK_PATHS.map((item) => path.basename(item)).join(" / ")}`);
  }
  const emoji = registerAvailableFonts(EMBEDDED_EMOJI_FONT_FAMILY, EMBEDDED_EMOJI_FONT_PATHS);
  if (emoji.length <= 0 && !hasAnySystemFontFamily(SYSTEM_EMOJI_FALLBACK_FAMILIES)) {
    logger.warn(
      `[activity] 未找到 emoji 字体，建议添加到 assert/fonts: ${EMBEDDED_EMOJI_FONT_PATHS.map((item) => path.basename(item)).join(" / ")}`,
    );
  }

  const cjk = registerAvailableFonts(EMBEDDED_CJK_FALLBACK_FONT_FAMILY, EMBEDDED_CJK_FALLBACK_PATHS);
  if (cjk.length <= 0 && !hasAnySystemFontFamily(SYSTEM_CJK_FALLBACK_FAMILIES)) {
    logger.warn(`[activity] 未在 assert/fonts 找到 CJK 兜底字体，建议添加: ${EMBEDDED_CJK_FALLBACK_PATHS.map((item) => path.basename(item)).join(" / ")}`);
  }
}

ensureRenderFonts();

type RankingItem = {
  userId: number;
  userName: string;
  count: number;
  percent: number;
};

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

function formatDateTimeCN(ts: number): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fillStyle: string,
): void {
  roundRect(ctx, x, y, w, h, r);
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  options?: {
    font?: string;
    color?: string;
    align?: "left" | "right" | "center" | "start" | "end";
    baseline?: "top" | "hanging" | "middle" | "alphabetic" | "ideographic" | "bottom";
  },
): void {
  ctx.font = options?.font ?? '28px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"';
  ctx.fillStyle = options?.color ?? "#333";
  ctx.textAlign = options?.align ?? "left";
  ctx.textBaseline = options?.baseline ?? "alphabetic";
  ctx.fillText(text, x, y);
}

function splitTextUnits(text: string): string[] {
  const SegmenterCtor = (Intl as unknown as { Segmenter?: new (...args: unknown[]) => {
    segment: (input: string) => Iterable<{ segment: string }>;
  } }).Segmenter;

  if (SegmenterCtor) {
    const segmenter = new SegmenterCtor("zh-CN", { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (item) => item.segment);
  }

  return Array.from(text);
}

function truncateText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const units = splitTextUnits(text);
  while (units.length > 1 && ctx.measureText(`${units.join("")}…`).width > maxWidth) {
    units.pop();
  }
  return `${units.join("")}…`;
}

function rankBadgeColor(rank: number): string {
  if (rank === 1) return "#f4b400";
  if (rank === 2) return "#b8b8bf";
  if (rank === 3) return "#d48a32";
  return "#6c63ff";
}

function avatarUrlByQq(userId: number, size = 100): string {
  return `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(String(userId))}&s=${size}`;
}

async function ensureQqAvatar(userId: number): Promise<string | undefined> {
  if (!Number.isFinite(userId) || userId <= 0) return undefined;
  ensureDir(AVATAR_DIR);
  const filePath = path.join(AVATAR_DIR, `${userId}.jpg`);
  try {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
    const response = await fetch(avatarUrlByQq(userId, 100));
    if (!response.ok) return undefined;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0) return undefined;
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    return undefined;
  }
}

async function loadAvatarImage(userId: number): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
  const local = await ensureQqAvatar(userId);
  if (!local) return null;
  try {
    return await loadImage(local);
  } catch {
    return null;
  }
}

async function loadImageSafe(source: string | Buffer): Promise<Awaited<ReturnType<typeof loadImage>> | null> {
  try {
    return await loadImage(source);
  } catch {
    return null;
  }
}

function drawAvatarFallback(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  userName: string,
  index: number,
): void {
  const color = `hsl(${(index * 47 + 210) % 360} 70% 60%)`;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  const initial = (userName.trim()[0] || "?").toUpperCase();
  drawText(ctx, initial, x + size / 2, y + size * 0.67, {
    font: `bold ${Math.floor(size * 0.45)}px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"`,
    color: "#fff",
    align: "center",
  });
}

function drawAvatarImage(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  image: Awaited<ReturnType<typeof loadImage>> | null,
  userName: string,
  index: number,
): void {
  if (!image) {
    drawAvatarFallback(ctx, x, y, size, userName, index);
    return;
  }

  ctx.save();
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.clip();
  (ctx as unknown as { drawImage: (img: unknown, dx: number, dy: number, dw: number, dh: number) => void })
    .drawImage(image, x, y, size, size);
  ctx.restore();
}

async function drawRankingCard(options: {
  title: string;
  subtitle: string;
  generatedAtMs: number;
  unitLabel: string;
  summaryLeft: { value: number; label: string };
  summaryRight: { value: number; label: string };
  items: RankingItem[];
  accent: string;
}): Promise<Buffer> {
  const width = 760;
  const rowHeight = 70;
  const listRows = Math.max(1, Math.min(10, options.items.length || 1));
  const cardHeight = 150 + listRows * rowHeight + 86;
  const height = cardHeight + 32;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const avatarImages = await Promise.all(
    options.items.slice(0, 10).map((item) => loadAvatarImage(item.userId)),
  );

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#6a50f3");
  bg.addColorStop(1, "#5560e7");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 14, 14, width - 28, cardHeight, 20, "#f4f4f6");

  drawText(ctx, options.title, width / 2, 66, {
    font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#2e2e34",
    align: "center",
  });
  drawText(ctx, options.subtitle, width / 2, 93, {
    font: '14px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#9a9aa2",
    align: "center",
  });
  drawText(ctx, formatDateTimeCN(options.generatedAtMs), width / 2, 113, {
    font: '14px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#b6b6bd",
    align: "center",
  });

  const startY = 128;
  const barColor = options.accent;
  const barBg = "#dfdfe8";

  if (options.items.length <= 0) {
    drawText(ctx, "今天暂无数据", width / 2, startY + 80, {
      font: '34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#666",
      align: "center",
    });
  }

  options.items.slice(0, 10).forEach((item, index) => {
    const rowY = startY + index * rowHeight;
    const rank = index + 1;

    if (index > 0) {
      ctx.strokeStyle = "#e5e5ee";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(32, rowY);
      ctx.lineTo(width - 32, rowY);
      ctx.stroke();
    }

    drawRoundedRect(ctx, 32, rowY + 13, 32, 32, 9, rankBadgeColor(rank));
    drawText(ctx, String(rank), 48, rowY + 35, {
      font: 'bold 18px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#fff",
      align: "center",
    });

    const avatarX = 76;
    const avatarY = rowY + 10;
    drawAvatarImage(ctx, avatarX, avatarY, 36, avatarImages[index] ?? null, item.userName, index);

    ctx.font = 'bold 18px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"';
    const name = truncateText(ctx, item.userName, 300);
    drawText(ctx, name, 122, rowY + 31, {
      font: 'bold 18px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#3a3a3f",
    });

    const valueText = `${item.count} ${options.unitLabel}`;
    drawText(ctx, valueText, width - 38, rowY + 31, {
      font: 'bold 16px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#666",
      align: "right",
    });

    const percentText = `${(item.percent * 100).toFixed(1)}%`;
    drawText(ctx, percentText, 122, rowY + 55, {
      font: '14px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: barColor,
    });

    drawRoundedRect(ctx, 188, rowY + 44, 248, 6, 3, barBg);
    drawRoundedRect(
      ctx,
      188,
      rowY + 44,
      Math.max(6, 248 * Math.max(0, Math.min(1, item.percent))),
      6,
      3,
      barColor,
    );
  });

  const summaryY = cardHeight - 46;
  ctx.strokeStyle = "#e1e1ea";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(32, summaryY - 28);
  ctx.lineTo(width - 32, summaryY - 28);
  ctx.stroke();

  drawText(ctx, String(options.summaryLeft.value), width * 0.25, summaryY, {
    font: 'bold 28px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#5b55df",
    align: "center",
  });
  drawText(ctx, options.summaryLeft.label, width * 0.25, summaryY + 18, {
    font: '12px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#b0b0b8",
    align: "center",
  });
  ctx.strokeStyle = "#e2e2ea";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(width / 2, summaryY - 6);
  ctx.lineTo(width / 2, summaryY + 20);
  ctx.stroke();
  drawText(ctx, String(options.summaryRight.value), width * 0.75, summaryY, {
    font: 'bold 28px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#5b55df",
    align: "center",
  });
  drawText(ctx, options.summaryRight.label, width * 0.75, summaryY + 18, {
    font: '12px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#b0b0b8",
    align: "center",
  });

  return canvas.toBuffer("image/png");
}

function writeCardBuffer(buffer: Buffer, prefix: string): string {
  ensureDir(OUTPUT_DIR);
  const filePath = path.join(OUTPUT_DIR, `${prefix}_${Date.now()}.png`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

export async function renderTalkStatsCard(stats: DailyTalkStatsResult): Promise<string> {
  const buffer = await drawRankingCard({
    title: "今日发言排行",
    subtitle: "活跃用户 TOP 10",
    generatedAtMs: stats.generatedAtMs,
    unitLabel: "条消息",
    summaryLeft: { value: stats.totalCount, label: "总发言消息数" },
    summaryRight: { value: stats.participantCount, label: "总参与人数" },
    items: stats.items,
    accent: "#f4b400",
  });
  return writeCardBuffer(buffer, "talk_stats");
}

export async function renderPointsRankingCard(stats: TotalPointsRankResult): Promise<string> {
  const buffer = await drawRankingCard({
    title: "积分排行榜",
    subtitle: "累计积分 TOP 10",
    generatedAtMs: stats.generatedAtMs,
    unitLabel: "分",
    summaryLeft: { value: stats.totalPoints, label: "总积分" },
    summaryRight: { value: stats.participantCount, label: "总参与人数" },
    items: stats.items,
    accent: "#f4b400",
  });
  return writeCardBuffer(buffer, "points_rank");
}

function drawEmojiTopItemPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  label: string,
  index: number,
): void {
  const bg = ["#f4b400", "#6c63ff", "#00b894"][index] ?? "#888";
  drawRoundedRect(ctx, x, y, size, size, 14, bg);
  drawText(ctx, label, x + size / 2, y + size / 2 - 6, {
    font: 'bold 14px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#fff",
    align: "center",
    baseline: "middle",
  });
}

async function drawEmojiTop3Panel(
  width: number,
  topEmojis: TopEmojiItem[],
): Promise<{ buffer: Buffer; height: number }> {
  const itemCount = Math.max(1, Math.min(3, topEmojis.length));
  const rowHeight = 160;
  const topPadding = 26;
  const titleHeight = 46;
  const panelHeight = topPadding + titleHeight + itemCount * rowHeight + 12;

  const canvas = createCanvas(width, panelHeight);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, panelHeight);

  drawText(ctx, `今日最受欢迎表情包TOP${Math.max(1, Math.min(3, topEmojis.length || 3))}:`, 20, 54, {
    font: 'bold 28px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#2e2e34",
  });

  const items = topEmojis.slice(0, 3);
  if (items.length <= 0) {
    drawText(ctx, "今天还没有表情包/表情使用记录", 20, 112, {
      font: '20px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#6f6f78",
    });
    return { buffer: canvas.toBuffer("image/png"), height: panelHeight };
  }

  for (const [index, item] of items.entries()) {
    const rowY = 78 + index * rowHeight;
    drawText(ctx, `${index + 1}. 使用次数: ${item.count}次`, 20, rowY + 22, {
      font: 'bold 20px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#2e2e34",
    });

    const thumbX = 20;
    const thumbY = rowY + 34;
    const thumbSize = 120;

    if (item.kind === "image" && item.assetRef) {
      const img = await loadImageSafe(item.assetRef);
      if (img) {
        drawRoundedRect(ctx, thumbX, thumbY, thumbSize, thumbSize, 14, "#f2f2f6");
        ctx.save();
        roundRect(ctx, thumbX, thumbY, thumbSize, thumbSize, 14);
        ctx.clip();
        (ctx as unknown as { drawImage: (img: unknown, dx: number, dy: number, dw: number, dh: number) => void })
          .drawImage(img, thumbX, thumbY, thumbSize, thumbSize);
        ctx.restore();
      } else {
        drawEmojiTopItemPlaceholder(ctx, thumbX, thumbY, thumbSize, "图片", index);
      }
    } else {
      drawEmojiTopItemPlaceholder(ctx, thumbX, thumbY, thumbSize, item.label, index);
    }

    if (item.kind !== "image") {
      drawText(ctx, item.label, thumbX + thumbSize + 16, thumbY + 34, {
        font: '16px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
        color: "#666",
      });
    }
  }

  return { buffer: canvas.toBuffer("image/png"), height: panelHeight };
}

export async function renderEmojiStatsCard(
  stats: DailyEmojiStatsResult,
  topEmojis: TopEmojiItem[] = [],
): Promise<string> {
  const rankingBuffer = await drawRankingCard({
    title: "今日表情包排行",
    subtitle: "活跃用户 TOP 10",
    generatedAtMs: stats.generatedAtMs,
    unitLabel: "次",
    summaryLeft: { value: stats.totalCount, label: "总使用次数" },
    summaryRight: { value: stats.participantCount, label: "总参与人数" },
    items: stats.items,
    accent: "#f4b400",
  });

  if (topEmojis.length <= 0) {
    return writeCardBuffer(rankingBuffer, "emoji_stats");
  }

  const rankingImage = await loadImageSafe(rankingBuffer);
  if (!rankingImage) {
    return writeCardBuffer(rankingBuffer, "emoji_stats");
  }

  const top3Panel = await drawEmojiTop3Panel(rankingImage.width, topEmojis);
  const canvas = createCanvas(rankingImage.width, rankingImage.height + top3Panel.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  (ctx as unknown as { drawImage: (img: unknown, dx: number, dy: number, dw: number, dh: number) => void })
    .drawImage(rankingImage, 0, 0, rankingImage.width, rankingImage.height);
  const panelImage = await loadImageSafe(top3Panel.buffer);
  if (panelImage) {
    (ctx as unknown as { drawImage: (img: unknown, dx: number, dy: number, dw: number, dh: number) => void })
      .drawImage(panelImage, 0, rankingImage.height, panelImage.width, panelImage.height);
  }

  return writeCardBuffer(canvas.toBuffer("image/png"), "emoji_stats");
}

export async function renderSignInCard(result: SignInResult): Promise<string> {
  const width = 980;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#6b52f5");
  bg.addColorStop(1, "#4f67ec");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 32, 32, width - 64, height - 64, 30, "#f5f5f7");

  drawText(ctx, result.status === "signed" ? "签到成功" : "今日已签到", width / 2, 110, {
    font: 'bold 56px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#2e2e34",
    align: "center",
  });
  drawText(ctx, formatDateTimeCN(result.signedAtMs), width / 2, 148, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#a8a8b0",
    align: "center",
  });

  drawRoundedRect(ctx, 70, 185, width - 140, 98, 20, "#ececff");
  const signAvatar = await loadAvatarImage(result.userId);
  drawAvatarImage(ctx, 88, 201, 64, signAvatar, result.userName, 0);
  drawText(ctx, result.userName, 172, 243, {
    font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#4a47d6",
  });
  drawText(ctx, `获得积分 +${result.rewardPoints}`, width - 100, 243, {
    font: '24px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#7f7fb0",
    align: "right",
  });

  const boxes = [
    { x: 70, y: 315, w: 250, title: "连续签到", value: `${result.streakDays} 天` },
    { x: 365, y: 315, w: 250, title: "累计积分", value: `${result.totalPoints} 分` },
    { x: 660, y: 315, w: 250, title: "今日序号", value: `第 ${result.seqToday} 签` },
  ];

  for (const box of boxes) {
    drawRoundedRect(ctx, box.x, box.y, box.w, 135, 18, "#ffffff");
    ctx.strokeStyle = "#e8e8f0";
    ctx.lineWidth = 2;
    roundRect(ctx, box.x, box.y, box.w, 135, 18);
    ctx.stroke();
    drawText(ctx, box.value, box.x + box.w / 2, box.y + 62, {
      font: 'bold 38px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#5b55df",
      align: "center",
    });
    drawText(ctx, box.title, box.x + box.w / 2, box.y + 102, {
      font: '20px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#9d9da8",
      align: "center",
    });
  }

  drawText(ctx, result.status === "signed" ? "今天也记一笔" : "已记录，明天再来", width / 2, 500, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#8d8d97",
    align: "center",
  });

  return writeCardBuffer(canvas.toBuffer("image/png"), "sign_in");
}

export async function renderRechargeCard(result: RechargePointsResult): Promise<string> {
  const width = 980;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#6b52f5");
  bg.addColorStop(1, "#4f67ec");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 32, 32, width - 64, height - 64, 30, "#f5f5f7");

  drawText(ctx, "充值成功", width / 2, 110, {
    font: 'bold 56px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#2e2e34",
    align: "center",
  });
  drawText(ctx, formatDateTimeCN(result.operatedAtMs), width / 2, 148, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#a8a8b0",
    align: "center",
  });

  drawRoundedRect(ctx, 70, 185, width - 140, 98, 20, "#ececff");
  const avatar = await loadAvatarImage(result.userId);
  drawAvatarImage(ctx, 88, 201, 64, avatar, result.userName, 0);
  drawText(ctx, result.userName, 172, 243, {
    font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#4a47d6",
  });
  drawText(ctx, `QQ ${result.userId}`, width - 100, 243, {
    font: '24px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#7f7fb0",
    align: "right",
  });

  const boxes = [
    { x: 70, y: 315, w: 250, title: "本次充值", value: `+${result.addedPoints} 分` },
    { x: 365, y: 315, w: 250, title: "当前总积分", value: `${result.totalPoints} 分` },
    { x: 660, y: 315, w: 250, title: "操作类型", value: "管理员充值" },
  ];

  for (const box of boxes) {
    drawRoundedRect(ctx, box.x, box.y, box.w, 135, 18, "#ffffff");
    ctx.strokeStyle = "#e8e8f0";
    ctx.lineWidth = 2;
    roundRect(ctx, box.x, box.y, box.w, 135, 18);
    ctx.stroke();
    drawText(ctx, box.value, box.x + box.w / 2, box.y + 62, {
      font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#5b55df",
      align: "center",
    });
    drawText(ctx, box.title, box.x + box.w / 2, box.y + 102, {
      font: '20px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#9d9da8",
      align: "center",
    });
  }

  drawText(ctx, "积分已计入全局累计", width / 2, 500, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#8d8d97",
    align: "center",
  });

  return writeCardBuffer(canvas.toBuffer("image/png"), "recharge");
}

export async function renderTransferCard(result: TransferPointsResult): Promise<string> {
  const width = 980;
  const height = 560;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, width, height);
  bg.addColorStop(0, "#6b52f5");
  bg.addColorStop(1, "#4f67ec");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, width, height);

  drawRoundedRect(ctx, 32, 32, width - 64, height - 64, 30, "#f5f5f7");

  drawText(ctx, "转账成功", width / 2, 110, {
    font: 'bold 56px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#2e2e34",
    align: "center",
  });
  drawText(ctx, formatDateTimeCN(result.operatedAtMs), width / 2, 148, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#a8a8b0",
    align: "center",
  });

  drawRoundedRect(ctx, 70, 185, width - 140, 98, 20, "#ececff");
  const avatar = await loadAvatarImage(result.fromUserId);
  drawAvatarImage(ctx, 88, 201, 64, avatar, result.fromUserName, 0);
  drawText(ctx, result.fromUserName, 172, 243, {
    font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#4a47d6",
  });
  drawText(ctx, `转给 QQ ${result.toUserId}`, width - 100, 243, {
    font: '24px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#7f7fb0",
    align: "right",
  });

  const boxes = [
    { x: 70, y: 315, w: 250, title: "本次转出", value: `-${result.transferredPoints} 分` },
    { x: 365, y: 315, w: 250, title: "我的剩余积分", value: `${result.fromTotalPoints} 分` },
    { x: 660, y: 315, w: 250, title: "收款方", value: `QQ ${result.toUserId}` },
  ];

  for (const box of boxes) {
    drawRoundedRect(ctx, box.x, box.y, box.w, 135, 18, "#ffffff");
    ctx.strokeStyle = "#e8e8f0";
    ctx.lineWidth = 2;
    roundRect(ctx, box.x, box.y, box.w, 135, 18);
    ctx.stroke();
    drawText(ctx, box.value, box.x + box.w / 2, box.y + 62, {
      font: 'bold 34px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#5b55df",
      align: "center",
    });
    drawText(ctx, box.title, box.x + box.w / 2, box.y + 102, {
      font: '20px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
      color: "#9d9da8",
      align: "center",
    });
  }

  drawText(ctx, `积分已转入 ${result.toUserName}`, width / 2, 500, {
    font: '22px "OvO Text", "OvO Symbol Fallback", "OvO Emoji", "OvO CJK Fallback"',
    color: "#8d8d97",
    align: "center",
  });

  return writeCardBuffer(canvas.toBuffer("image/png"), "transfer");
}


