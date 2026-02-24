import { buildPersonaPrompt } from "./persona";
import { formatMaiBotReplyPrompt } from "./maibot_prompt_templates";
import type { PromptStateContext } from "./state_engine";
import type { ChatQuotedMessage, PersonaProfile, SessionMessage } from "./types";
import type { ChatStyleVariant } from "./action_planner";

export type BuildContextInput = {
  persona: PersonaProfile;
  history: SessionMessage[];
  archivedSummaries: string[];
  longTermFacts: string[];
  userDisplayName?: string;
  userText: string;
  quotedMessage?: ChatQuotedMessage;
  scope: "group" | "private";
  mediaCount: number;
  eventTimeMs?: number;
  stateContext?: PromptStateContext;
  toolContext?: string;
  styleVariant?: ChatStyleVariant;
  plannerHint?: string;
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
    .map((item) => {
      const fallbackName = item.role === "user" ? "用户" : "小o";
      const speakerName = item.speakerName?.trim() || fallbackName;
      return `${speakerName}: ${item.text}`;
    })
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
  const quotedMessageText = input.quotedMessage?.text?.trim();
  const quotedMessageHint = quotedMessageText
    ? `用户引用消息${input.quotedMessage?.senderName ? `（来自${input.quotedMessage.senderName}）` : ""}：${quotedMessageText}`
    : "用户引用消息：无";
  const mediaHint =
    input.mediaCount > 0 ? `附加媒体数量：${input.mediaCount}（可能为图片或GIF）` : "附加媒体数量：0";
  const userNameHint = input.userDisplayName ? `用户称呼参考：${input.userDisplayName}` : "用户称呼参考：未知";
  const timeHint = `当前消息时间（NapCat事件时间）：${formatEventTime(input.eventTimeMs)}`;
  const toolContext = input.toolContext?.trim() || "(本轮未调用工具)";
  const emotionHint =
    input.stateContext
      ? `当前情感：${input.stateContext.emotionLabel} (score=${input.stateContext.emotionScore.toFixed(2)})`
      : "当前情感：未知";
  const userProfileHint = input.stateContext
    ? `目标用户信息：${input.stateContext.userProfileText}；${input.stateContext.relationshipText}`
    : "目标用户信息：未知";
  const groupTopicHint =
    input.scope === "group"
      ? `群聊主话题：${input.stateContext?.groupTopicText ?? "未知"}`
      : "群聊主话题：私聊场景";
  const groupActivityHint =
    input.scope === "group"
      ? `群活跃度：${input.stateContext?.groupActivityText ?? "未知"}`
      : "群活跃度：私聊场景";
  const plannerStyleHint = input.styleVariant
    ? `表达风格：${input.styleVariant}`
    : "表达风格：default";
  const plannerHint = input.plannerHint?.trim() || "(无)";
  const extraInfoBlock = [
    `场景：${scene}`,
    timeHint,
    userNameHint,
    emotionHint,
    userProfileHint,
    groupTopicHint,
    groupActivityHint,
    plannerStyleHint,
    mediaHint,
  ].join("\n");

  const knowledgePrompt = [
    "用户长期记忆（历史偏好/身份/梗）：",
    longTermFactsText,
    "",
    "较早会话归档摘要：",
    archivedSummaryText,
    "",
  ].join("\n");

  const toolInfoBlock = [
    "工具调用上下文：",
    toolContext,
    "",
  ].join("\n");

  return formatMaiBotReplyPrompt({
    knowledge_prompt: knowledgePrompt,
    tool_info_block: toolInfoBlock,
    extra_info_block: `${extraInfoBlock}\n`,
    identity_block: personaPrompt,
    scene_label: scene,
    dialogue_intro: "以下是最近会话（按时间顺序）：",
    dialogue_prompt: historyText,
    quoted_message_block: quotedMessageHint,
    user_message: normalizedUserText,
    planner_reasoning: plannerHint,
    reply_style: `回复长度要求：${input.persona.replyLength === "short" ? "默认 1-2 句" : "默认 2-4 句"}。`,
  });
}
