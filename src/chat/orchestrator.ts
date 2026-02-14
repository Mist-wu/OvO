import { config } from "../config";
import { configStore } from "../storage/config_store";
import { planChatAction } from "./action_planner";
import { createChatContextPipeline } from "./context_pipeline";
import { resolveVisualInputs } from "./media";
import { ChatMemoryManager } from "./memory";
import { getPersonaProfile } from "./persona";
import { generateChatReply } from "./reply";
import { createSessionKey, InMemorySessionStore } from "./session_store";
import { chatStateEngine } from "./state_engine";
import { routeChatTool } from "./tool_router";
import { decideTrigger } from "./trigger";
import type { ChatEvent, ChatReply, TriggerDecision } from "./types";

export type PreparedChatReply = {
  event: ChatEvent;
  sessionKey: string;
  normalizedUserText: string;
  reply: ChatReply;
};

export interface ChatOrchestrator {
  decide(event: ChatEvent): TriggerDecision;
  prepare(
    event: ChatEvent,
    decision?: TriggerDecision,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedChatReply | null>;
  commit(prepared: PreparedChatReply): void;
  handle(event: ChatEvent, decision?: TriggerDecision): Promise<ChatReply | null>;
}

class DefaultChatOrchestrator implements ChatOrchestrator {
  private readonly sessions = new InMemorySessionStore(config.chat.maxSessionMessages);
  private readonly memory = new ChatMemoryManager(this.sessions);
  private readonly contextPipeline = createChatContextPipeline();

  decide(event: ChatEvent): TriggerDecision {
    if (!config.chat.enabled) {
      return {
        shouldReply: false,
        reason: "not_triggered",
        priority: "low",
        waitMs: 0,
        willingness: 0,
      };
    }

    if (
      event.scope === "group" &&
      typeof event.groupId === "number" &&
      !configStore.isGroupEnabled(event.groupId)
    ) {
      return {
        shouldReply: false,
        reason: "group_disabled",
        priority: "low",
        waitMs: 0,
        willingness: 0,
      };
    }

    const hints = chatStateEngine.getTriggerHints(event);
    return decideTrigger(event, config.chat.botAliases, hints);
  }

  async prepare(
    event: ChatEvent,
    decisionInput?: TriggerDecision,
    options?: { signal?: AbortSignal },
  ): Promise<PreparedChatReply | null> {
    const decision = decisionInput ?? this.decide(event);
    if (!decision.shouldReply) {
      return null;
    }

    const sessionKey = createSessionKey(event);
    const history = this.sessions.get(sessionKey);
    const stateContext = chatStateEngine.getPromptState(event);
    const visuals = await resolveVisualInputs(event.segments, options?.signal);
    const normalizedUserText = summarizeUserMessage(event.text, visuals.length);
    const toolResult = await routeChatTool(event, options?.signal);
    const plan = planChatAction({
      event,
      decision,
      normalizedUserText,
      toolResult,
      stateContext,
    });
    if (plan.type === "no_reply") {
      return null;
    }
    const persona = getPersonaProfile({ styleVariant: plan.styleVariant });
    const memoryContext = this.memory.getContext(
      event,
      sessionKey,
      plan.memoryMode === "lite"
        ? {
          factCount: Math.min(3, config.chat.memoryContextFactCount),
          summaryCount: Math.min(1, config.chat.summaryContextCount),
        }
        : undefined,
    );
    const quoteMessageId = plan.shouldQuote ? event.messageId : undefined;

    if (plan.type === "tool_direct" && toolResult.type === "direct") {
      return {
        event,
        sessionKey,
        normalizedUserText,
        reply: {
          text: toolResult.text,
          from: "tool",
          quoteMessageId,
          plannerReason: plan.reason,
          styleVariant: plan.styleVariant,
          reason: decision.reason,
          priority: decision.priority,
          willingness: decision.willingness,
        },
      };
    }

    const prompt = await this.contextPipeline.run({
      persona,
      history,
      archivedSummaries: memoryContext.archivedSummaries,
      longTermFacts: memoryContext.longTermFacts,
      userDisplayName: memoryContext.userDisplayName,
      userText: event.text,
      scope: event.scope,
      mediaCount: visuals.length,
      eventTimeMs: event.eventTimeMs,
      stateContext,
      styleVariant: plan.styleVariant,
      plannerHint: `action=${plan.type}; reason=${plan.reason}; quote=${quoteMessageId !== undefined ? "on" : "off"}; memory=${plan.memoryMode}`,
      toolContext: toolResult.type === "context" ? toolResult.contextText : undefined,
    }, options?.signal);

    const generated = await generateChatReply({
      prompt,
      visuals,
      seed: `${sessionKey}:${event.messageId ?? event.eventTimeMs ?? Date.now()}:${plan.styleVariant}`,
      signal: options?.signal,
    });
    const reply =
      toolResult.type === "context" && generated.from === "fallback"
        ? {
          text: toolResult.fallbackText,
          from: "tool" as const,
        }
        : generated;

    return {
      event,
      sessionKey,
      normalizedUserText,
      reply: {
        ...reply,
        quoteMessageId,
        plannerReason: plan.reason,
        styleVariant: plan.styleVariant,
        reason: decision.reason,
        priority: decision.priority,
        willingness: decision.willingness,
      },
    };
  }

  commit(prepared: PreparedChatReply): void {
    this.recordConversationTurn(
      prepared.sessionKey,
      prepared.event,
      prepared.normalizedUserText,
      prepared.reply.text,
    );
  }

  async handle(event: ChatEvent, decisionInput?: TriggerDecision): Promise<ChatReply | null> {
    const prepared = await this.prepare(event, decisionInput);
    if (!prepared) {
      return null;
    }
    this.commit(prepared);
    return prepared.reply;
  }

  private recordConversationTurn(
    sessionKey: string,
    event: ChatEvent,
    normalizedUserText: string,
    replyText: string,
  ): void {
    this.sessions.append(sessionKey, {
      role: "user",
      text: normalizedUserText,
      ts: Date.now(),
    });
    this.sessions.append(sessionKey, {
      role: "assistant",
      text: replyText,
      ts: Date.now(),
    });
    this.memory.recordTurn({
      event,
      sessionKey,
      userText: normalizedUserText,
    });
    chatStateEngine.recordReply(event, replyText);
  }
}

function summarizeUserMessage(text: string, mediaCount: number): string {
  const normalizedText = text.trim();
  if (normalizedText && mediaCount <= 0) {
    return normalizedText;
  }
  if (!normalizedText && mediaCount > 0) {
    return `[图片/表情包 x${mediaCount}]`;
  }
  if (normalizedText && mediaCount > 0) {
    return `${normalizedText} [图片/表情包 x${mediaCount}]`;
  }
  return "(空消息)";
}

export function createChatOrchestrator(): ChatOrchestrator {
  return new DefaultChatOrchestrator();
}
