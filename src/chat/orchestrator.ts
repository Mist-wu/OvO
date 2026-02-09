import { config } from "../config";
import { configStore } from "../storage/config_store";
import { buildPrompt } from "./context_builder";
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

    const prompt = buildPrompt({
      persona,
      history,
      userText: event.text,
      scope: event.scope,
    });

    const reply = await generateChatReply(prompt);
    this.sessions.append(sessionKey, {
      role: "user",
      text: event.text,
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

export function createChatOrchestrator(): ChatOrchestrator {
  return new DefaultChatOrchestrator();
}
