import { buildPersonaPrompt } from "./persona";
import type { PersonaProfile, SessionMessage } from "./types";

export type BuildContextInput = {
  persona: PersonaProfile;
  history: SessionMessage[];
  archivedSummaries: string[];
  longTermFacts: string[];
  userDisplayName?: string;
  userText: string;
  scope: "group" | "private";
  mediaCount: number;
  eventTimeMs?: number;
  toolContext?: string;
};

function formatEventTime(eventTimeMs: number | undefined): string {
  const ts = typeof eventTimeMs === "number" && Number.isFinite(eventTimeMs) ? eventTimeMs : Date.now();
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function formatHistory(history: SessionMessage[]): string {
  if (history.length === 0) return "(无历史)";
  return history
    .map((item) => `${item.role === "user" ? "用户" : "小o"}: ${item.text}`)
    .join("\n");
}

export function buildPrompt(input: BuildContextInput): string {
  const scene = input.scope === "group" ? "群聊" : "私聊";
  const personaPrompt = buildPersonaPrompt(input.persona);
  const historyText = formatHistory(input.history);
  const archivedSummaryText =
    input.archivedSummaries.length > 0
      ? input.archivedSummaries.map((item, index) => `S${index + 1}: ${item}`).join("\n")
      : "(暂无归档摘要)";
  const longTermFactsText =
    input.longTermFacts.length > 0
      ? input.longTermFacts.map((item, index) => `${index + 1}. ${item}`).join("\n")
      : "(暂无长期记忆)";
  const normalizedUserText = input.userText.trim() || "(无文本，仅图片/表情包)";
  const mediaHint =
    input.mediaCount > 0 ? `附加媒体数量：${input.mediaCount}（可能为图片或GIF）` : "附加媒体数量：0";
  const userNameHint = input.userDisplayName ? `用户称呼参考：${input.userDisplayName}` : "用户称呼参考：未知";
  const timeHint = `当前消息时间（NapCat事件时间）：${formatEventTime(input.eventTimeMs)}`;
  const toolContext = input.toolContext?.trim() || "(本轮未调用工具)";

  return [
    personaPrompt,
    `场景：${scene}`,
    timeHint,
    userNameHint,
    mediaHint,
    "工具调用上下文：",
    toolContext,
    "用户长期记忆（历史偏好/身份/梗）：",
    longTermFactsText,
    "较早会话归档摘要：",
    archivedSummaryText,
    "以下是最近会话（按时间顺序）：",
    historyText,
    `用户当前消息：${normalizedUserText}`,
    "请直接输出回复正文，不要附加解释。",
  ].join("\n\n");
}
