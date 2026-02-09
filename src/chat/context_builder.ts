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
};

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

  return [
    personaPrompt,
    `场景：${scene}`,
    userNameHint,
    mediaHint,
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
