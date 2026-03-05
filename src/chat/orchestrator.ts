import { config } from "../config";
import { resolveVisualInputs } from "./media";
import { generateChatReply } from "./reply";
import { decideTrigger } from "./trigger";
import type { ChatEvent, ChatReply, TriggerDecision } from "./types";

type PreparedChatReply = {
  reply: ChatReply;
};

interface ChatOrchestrator {
  decide(event: ChatEvent): TriggerDecision;
  prepare(
    event: ChatEvent,
    decision?: TriggerDecision,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedChatReply | null>;
  commit(prepared: PreparedChatReply): void;
  handle(event: ChatEvent, decision?: TriggerDecision): Promise<ChatReply | null>;
}

class MinimalChatOrchestrator implements ChatOrchestrator {
  decide(event: ChatEvent): TriggerDecision {
    if (!config.chat.enabled) {
      return {
        shouldReply: false,
        reason: "not_triggered",
        priority: "low",
        willingness: 0,
      };
    }
    return decideTrigger(event);
  }

  async prepare(
    event: ChatEvent,
    decisionInput?: TriggerDecision,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedChatReply | null> {
    const decision = decisionInput ?? this.decide(event);
    if (!decision.shouldReply) return null;

    const directVisuals = await resolveVisualInputs(event.segments, options?.signal);
    let quotedVisuals: Awaited<ReturnType<typeof resolveVisualInputs>> = [];
    if (event.quotedMessage?.segments?.length) {
      const room = Math.max(0, config.chat.mediaMaxImages - directVisuals.length);
      if (room > 0) {
        quotedVisuals = (await resolveVisualInputs(event.quotedMessage.segments, options?.signal)).slice(0, room);
      }
    }
    const visuals = [...directVisuals, ...quotedVisuals];

    const systemPrompt = buildChatSystemPrompt();
    const prompt = buildChatUserPrompt(event, visuals.length);
    const generated = await generateChatReply({
      systemPrompt,
      prompt,
      visuals,
      grounding: {
        enabled: config.chat.groundingEnabled,
      },
      signal: options?.signal,
      seed: `${event.scope}:${event.groupId ?? 0}:${event.userId}:${event.messageId ?? Date.now()}`,
    });

    const quoteMessageId =
      event.scope === "group" &&
      event.messageId !== undefined &&
      config.chat.quoteMode !== "off"
        ? event.messageId
        : undefined;

    return {
      reply: {
        ...generated,
        quoteMessageId,
        reason: decision.reason,
        priority: decision.priority,
        willingness: decision.willingness,
      },
    };
  }

  commit(_prepared: PreparedChatReply): void {
    // 最小模式：不保留会话/长期记忆
  }

  async handle(event: ChatEvent, decisionInput?: TriggerDecision): Promise<ChatReply | null> {
    const prepared = await this.prepare(event, decisionInput);
    if (!prepared) return null;
    this.commit(prepared);
    return prepared.reply;
  }
}

function buildChatSystemPrompt(): string {
  return [
    "你是一个AI助手，无特殊要求的话使用中文回答。",
    "允许普通换行；禁止使用所有Markdown语法结构，包括标题、列表、引用、代码块、分隔线、表格、任务列表，尤其不要使用“*”",
    "优先用 1–4 句话回答。",
    "不要写长篇分析，除非用户明确要求“详细解释”或“深入分析”，无论如何输出必须小于200字。",
    "如果是简单闲聊，只需自然回应，不需要解释知识。",
  ].join("\n");
}

function buildChatUserPrompt(event: ChatEvent, _mediaCount: number): string {
  const quoted = event.quotedMessage
    ? `引用内容${event.quotedMessage.senderName ? `（来自${event.quotedMessage.senderName}）` : ""}：${event.quotedMessage.text}`
    : "";
  const userText = event.text.trim() || "(无文本)";

  return [
    event.senderName ? `发送者：${event.senderName}` : "",
    quoted,
    `用户消息：${userText}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createChatOrchestrator(): ChatOrchestrator {
  return new MinimalChatOrchestrator();
}
