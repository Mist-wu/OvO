import { config } from "../config";
import { resolveVisualInputs } from "./media";
import { generateChatReply } from "./reply";
import { chatSessionStore, type ChatConversationMessage } from "./session";
import { decideTrigger } from "./trigger";
import type { ChatEvent, ChatReply, TriggerDecision } from "./types";

type PreparedChatReply = {
  reply: ChatReply;
};

type ChatOrchestrator = {
  decide(event: ChatEvent): TriggerDecision;
  prepare(
    event: ChatEvent,
    decision?: TriggerDecision,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedChatReply | null>;
  commit(): void;
  handle(event: ChatEvent, decision?: TriggerDecision): Promise<ChatReply | null>;
};

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
    const recentMessages = chatSessionStore.getRecentMessages(event);

    const systemPrompt = buildChatSystemPrompt();
    const prompt = buildChatUserPrompt(event, recentMessages);
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

  commit(): void {}

  async handle(event: ChatEvent, decisionInput?: TriggerDecision): Promise<ChatReply | null> {
    const prepared = await this.prepare(event, decisionInput);
    if (!prepared) return null;
    this.commit();
    return prepared.reply;
  }
}

function buildChatSystemPrompt(): string {
  return [
    "你是 QQ 里的聊天助手，无特殊要求的话使用中文回答。",
    "允许普通换行；禁止使用所有Markdown语法结构，包括标题、列表、引用、代码块、分隔线、表格、任务列表，尤其不要使用“*”",
    "优先用 1-4 句话回答。",
    "不要写长篇分析，除非用户明确要求“详细解释”或“深入分析”，无论如何输出必须小于200字。",
    "如果是简单闲聊，只需自然回应，不需要解释知识。",
  ].join("\n");
}

export function formatSpeakerLabel(options: {
  scope: "group" | "private";
  role?: "user" | "assistant";
  userId?: number | string;
  senderName?: string;
}): string {
  const rawName = options.senderName?.trim() || "";

  if (options.role === "assistant") {
    if (rawName) return rawName;
    return "机器人";
  }

  if (rawName) return rawName;
  if (options.scope === "group") return "群成员";
  return "对方";
}

function indentPromptText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => `  ${line}`)
    .join("\n");
}

function buildRecentMessagesPrompt(
  messages: ChatConversationMessage[],
  scope: "group" | "private",
): string {
  if (messages.length <= 0) return "";

  const lines = ["最近消息（按时间顺序）："];
  for (const [index, message] of messages.entries()) {
    const speaker = formatSpeakerLabel({
      scope,
      role: message.role,
      userId: message.userId,
      senderName: message.senderName,
    });
    const roleLabel = message.role === "assistant" ? "机器人" : "用户";
    lines.push(`${index + 1}. ${roleLabel} ${speaker}：${message.text}`);
  }
  return lines.join("\n");
}

function buildQuotedMessagePrompt(event: ChatEvent): string {
  if (!event.quotedMessage) return "";

  const quotedSenderLabel = formatSpeakerLabel({
    scope: event.scope,
    role: "user",
    userId: event.quotedMessage.userId,
    senderName: event.quotedMessage.senderName,
  });

  return [
    "当前消息引用了下面这条消息：",
    `发送者：${quotedSenderLabel}`,
    "引用内容：",
    indentPromptText(event.quotedMessage.text.trim() || "(无文本)"),
  ].join("\n");
}

export function buildChatUserPrompt(
  event: ChatEvent,
  recentMessages: ChatConversationMessage[],
): string {
  const senderLabel = formatSpeakerLabel({
    scope: event.scope,
    role: "user",
    userId: event.userId,
    senderName: event.senderName,
  });
  const userText = event.text.trim() || "(无文本)";

  return [
    buildRecentMessagesPrompt(recentMessages, event.scope),
    `当前消息发送者：${senderLabel}`,
    buildQuotedMessagePrompt(event),
    "当前消息内容：",
    indentPromptText(userText),
  ]
    .filter(Boolean)
    .join("\n");
}

export function createChatOrchestrator(): ChatOrchestrator {
  return new MinimalChatOrchestrator();
}
