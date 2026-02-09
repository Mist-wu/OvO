import { config } from "../config";
import { configStore } from "../storage/config_store";
import { buildPrompt } from "./context_builder";
import { resolveVisualInputs } from "./media";
import { getPersonaProfile } from "./persona";
import { generateChatReply } from "./reply";
import { createSessionKey, InMemorySessionStore } from "./session_store";
import { decideTrigger } from "./trigger";
import type { ChatEvent, ChatReply } from "./types";

export interface ChatOrchestrator {
  handle(event: ChatEvent): Promise<ChatReply | null>;
}

class DefaultChatOrchestrator implements ChatOrchestrator {
  private readonly sessions = new InMemorySessionStore(config.chat.maxSessionMessages);

  async handle(event: ChatEvent): Promise<ChatReply | null> {
    if (!config.chat.enabled) {
      return null;
    }

    if (
      event.scope === "group" &&
      typeof event.groupId === "number" &&
      !configStore.isGroupEnabled(event.groupId)
    ) {
      return null;
    }

    const decision = decideTrigger(event, config.chat.botAliases);
    if (!decision.shouldReply) {
      return null;
    }

    const sessionKey = createSessionKey(event);
    const history = this.sessions.get(sessionKey);
    const persona = getPersonaProfile();
    const visuals = await resolveVisualInputs(event.segments);

    const prompt = buildPrompt({
      persona,
      history,
      userText: event.text,
      scope: event.scope,
      mediaCount: visuals.length,
    });

    const reply = await generateChatReply({
      prompt,
      visuals,
    });

    const normalizedUserText = summarizeUserMessage(event.text, visuals.length);
    this.sessions.append(sessionKey, {
      role: "user",
      text: normalizedUserText,
      ts: Date.now(),
    });
    this.sessions.append(sessionKey, {
      role: "assistant",
      text: reply.text,
      ts: Date.now(),
    });

    return {
      ...reply,
      reason: decision.reason,
    };
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
