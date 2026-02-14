import { config } from "../config";
import { clamp01, normalizeText } from "../utils/helpers";
import type { PromptStateContext } from "./state_engine";
import type { ToolRouteResult } from "./tool_router";
import type { ChatEvent, TriggerDecision } from "./types";

export type ChatStyleVariant = "default" | "warm" | "playful" | "concise";

export type ChatActionType =
  | "no_reply"
  | "wait"
  | "complete_talk"
  | "tool_direct"
  | "tool_context"
  | "llm";

export type ChatActionPlan = {
  type: ChatActionType;
  reason: string;
  shouldQuote: boolean;
  styleVariant: ChatStyleVariant;
  memoryMode: "full" | "lite";
  waitMs?: number;
  completeTalkText?: string;
  toolRetryHint?: "none" | "retry_once";
};

export type PlanChatActionInput = {
  event: ChatEvent;
  decision: TriggerDecision;
  normalizedUserText: string;
  toolResult: ToolRouteResult;
  stateContext?: PromptStateContext;
};

const LOW_VALUE_MESSAGE_REGEX = /^(哈哈+|hhh+|6+|哦+|嗯+|ok+|好的+|收到+|行吧+|[?？!！.。]+)$/i;
const HIGH_VALUE_QUERY_REGEX =
  /(怎么|如何|为啥|为什么|建议|推荐|帮忙|排查|教程|步骤|最新|新闻|文档|报错|bug|代码|项目|天气|汇率|时间|计算|搜索)/;
const COMPLETE_TALK_REGEX =
  /(先这样|先到这|不聊了|先睡了|晚安|回头聊|没事了|先忙|下了|撤了|谢谢你|谢啦|收到就行|懂了先这样)/;
const UNFINISHED_SUFFIX_REGEX = /(然后|还有|另外|就是|但是|以及|我再想想|等下|稍等)$/;

function stableRatio(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function isLowValueMessage(text: string): boolean {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return true;
  if (LOW_VALUE_MESSAGE_REGEX.test(normalized)) return true;
  if (normalized.length <= 4 && !/[?？]/.test(normalized)) return true;
  return false;
}

function isHighValueQuery(text: string, toolResult: ToolRouteResult): boolean {
  const normalized = normalizeText(text);
  if (toolResult.type !== "none") return true;
  if (!normalized) return false;
  if (/[?？]/.test(normalized)) return true;
  if (normalized.length >= 24) return true;
  return HIGH_VALUE_QUERY_REGEX.test(normalized);
}

function isLikelyUnfinishedText(text: string): boolean {
  const normalized = normalizeText(text);
  if (!normalized) return true;
  if (/[，,、….]$/.test(normalized)) return true;
  if (UNFINISHED_SUFFIX_REGEX.test(normalized)) return true;
  if (normalized.length <= 12 && !/[。！？!?]$/.test(normalized)) return true;
  return false;
}

function buildCompleteTalkText(styleVariant: ChatStyleVariant, scope: ChatEvent["scope"]): string {
  if (scope === "group") {
    if (styleVariant === "playful") return "行，这趴先收工～";
    if (styleVariant === "concise") return "好，先这样。";
    if (styleVariant === "warm") return "好呀，先这样，有需要再叫我。";
    return "好，先这样，有事再喊我。";
  }
  if (styleVariant === "playful") return "ok，这轮先到这，我在～";
  if (styleVariant === "concise") return "好，先这样。";
  if (styleVariant === "warm") return "好，先这样，你先忙～需要我再叫我。";
  return "好，先这样，有需要再找我。";
}

function inferAdaptiveVariantByState(stateContext: PromptStateContext | undefined): ChatStyleVariant | undefined {
  if (!config.chat.adaptivePersonaEnabled || !stateContext) return undefined;
  if (stateContext.emotionLabel === "negative") return "warm";
  if (stateContext.relationshipText.includes("偏低")) return "warm";
  if (stateContext.groupActivityText.includes("高活跃")) return "concise";
  if (stateContext.emotionLabel === "excited") return "playful";
  return undefined;
}

function pickStyleVariant(input: PlanChatActionInput): ChatStyleVariant {
  if (!config.chat.styleVariantEnabled) {
    return "default";
  }

  const adaptiveVariant = inferAdaptiveVariantByState(input.stateContext);
  if (adaptiveVariant) {
    return adaptiveVariant;
  }

  if (input.decision.priority === "must") {
    return "concise";
  }

  const switchProb = clamp01(config.chat.styleSwitchProb);
  const seed = [
    input.event.scope,
    input.event.userId,
    input.event.groupId ?? "private",
    input.event.eventTimeMs ?? 0,
    input.normalizedUserText,
  ].join("|");
  const ratio = stableRatio(seed);
  if (ratio > switchProb) {
    return "default";
  }

  const emotion = input.stateContext?.emotionLabel;
  if (emotion === "negative") return "warm";
  if (emotion === "excited") return "playful";
  if (input.normalizedUserText.length >= 34) return "concise";
  return ratio < switchProb * 0.5 ? "playful" : "warm";
}

function decideQuote(input: PlanChatActionInput): boolean {
  if (input.event.scope !== "group") return false;
  if (input.event.messageId === undefined) return false;

  if (config.chat.quoteMode === "off") return false;
  if (config.chat.quoteMode === "on") return true;

  if (input.decision.reason === "mentioned" || input.decision.reason === "replied_to_bot") {
    return true;
  }
  if (/[?？]/.test(input.normalizedUserText) && input.normalizedUserText.length <= 80) {
    return true;
  }
  return false;
}

function decideWaitMs(input: PlanChatActionInput): number {
  if (!config.chat.plannerWaitEnabled) return 0;
  if (input.decision.priority === "must") return 0;
  if (input.toolResult.type !== "none") return 0;
  if (!isLikelyUnfinishedText(input.normalizedUserText)) return 0;

  const base = input.event.scope === "group"
    ? Math.max(0, Math.floor(config.chat.plannerWaitGroupExtraMs))
    : Math.max(0, Math.floor(config.chat.plannerWaitPrivateExtraMs));
  const cap = Math.max(0, Math.floor(config.chat.plannerWaitMaxMs));
  return Math.min(cap, base);
}

function shouldCompleteTalk(input: PlanChatActionInput): boolean {
  if (!config.chat.plannerCompleteTalkEnabled) return false;
  if (input.toolResult.type !== "none") return false;
  const normalized = normalizeText(input.normalizedUserText);
  if (!normalized) return false;
  if (normalized.length > 36) return false;
  return COMPLETE_TALK_REGEX.test(normalized);
}

export function planChatAction(input: PlanChatActionInput): ChatActionPlan {
  if (!input.decision.shouldReply) {
    return {
      type: "no_reply",
      reason: "trigger_blocked",
      shouldQuote: false,
      styleVariant: "default",
      memoryMode: "lite",
      toolRetryHint: "none",
    };
  }

  const normalizedText = normalizeText(input.normalizedUserText);
  const styleVariant = pickStyleVariant(input);
  const shouldQuote = decideQuote(input);
  const memoryMode = isHighValueQuery(normalizedText, input.toolResult) ? "full" : "lite";
  const waitMs = decideWaitMs(input);

  if (shouldCompleteTalk(input)) {
    return {
      type: "complete_talk",
      reason: "complete_talk_detected",
      shouldQuote,
      styleVariant,
      memoryMode: "lite",
      completeTalkText: buildCompleteTalkText(styleVariant, input.event.scope),
      toolRetryHint: "none",
    };
  }

  if (
    input.event.scope === "group" &&
    input.decision.reason === "group_willing" &&
    input.decision.willingness < 0.66 &&
    isLowValueMessage(normalizedText)
  ) {
    return {
      type: "no_reply",
      reason: "low_value_group_message",
      shouldQuote: false,
      styleVariant,
      memoryMode: "lite",
      toolRetryHint: "none",
    };
  }

  if (waitMs > 0) {
    return {
      type: "wait",
      reason: "unfinished_text_wait",
      shouldQuote,
      styleVariant,
      memoryMode,
      waitMs,
      toolRetryHint: "none",
    };
  }

  if (input.toolResult.type === "direct") {
    return {
      type: "tool_direct",
      reason: `tool:${input.toolResult.tool}`,
      shouldQuote,
      styleVariant,
      memoryMode,
      toolRetryHint: "none",
    };
  }

  if (input.toolResult.type === "context") {
    return {
      type: "tool_context",
      reason: `tool_context:${input.toolResult.tool}`,
      shouldQuote,
      styleVariant,
      memoryMode,
      toolRetryHint: "retry_once",
    };
  }

  return {
    type: "llm",
    reason: "llm_default",
    shouldQuote,
    styleVariant,
    memoryMode,
    toolRetryHint: "none",
  };
}
