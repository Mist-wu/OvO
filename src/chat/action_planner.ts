import { config } from "../config";
import { clamp01, normalizeText } from "../utils/helpers";
import type { PromptStateContext } from "./state_engine";
import type { ToolRouteResult } from "./tool_router";
import type { ChatEvent, TriggerDecision } from "./types";

export type ChatStyleVariant = "default" | "warm" | "playful" | "concise";

export type ChatActionType = "no_reply" | "tool_direct" | "tool_context" | "llm";

export type ChatActionPlan = {
  type: ChatActionType;
  reason: string;
  shouldQuote: boolean;
  styleVariant: ChatStyleVariant;
  memoryMode: "full" | "lite";
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

function pickStyleVariant(input: PlanChatActionInput): ChatStyleVariant {
  if (!config.chat.styleVariantEnabled) {
    return "default";
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

export function planChatAction(input: PlanChatActionInput): ChatActionPlan {
  if (!input.decision.shouldReply) {
    return {
      type: "no_reply",
      reason: "trigger_blocked",
      shouldQuote: false,
      styleVariant: "default",
      memoryMode: "lite",
    };
  }

  const normalizedText = normalizeText(input.normalizedUserText);
  const styleVariant = pickStyleVariant(input);
  const shouldQuote = decideQuote(input);
  const memoryMode = isHighValueQuery(normalizedText, input.toolResult) ? "full" : "lite";

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
    };
  }

  if (input.toolResult.type === "direct") {
    return {
      type: "tool_direct",
      reason: `tool:${input.toolResult.tool}`,
      shouldQuote,
      styleVariant,
      memoryMode,
    };
  }

  if (input.toolResult.type === "context") {
    return {
      type: "tool_context",
      reason: `tool_context:${input.toolResult.tool}`,
      shouldQuote,
      styleVariant,
      memoryMode,
    };
  }

  return {
    type: "llm",
    reason: "llm_default",
    shouldQuote,
    styleVariant,
    memoryMode,
  };
}
