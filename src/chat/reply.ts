import { askGemini } from "../llm";
import { config } from "../config";
import { sanitizeReply } from "./safety";
import type { ChatReply } from "./types";

export async function generateChatReply(prompt: string): Promise<ChatReply> {
  try {
    const raw = await askGemini(prompt);
    return {
      text: sanitizeReply(raw),
      from: "llm",
    };
  } catch (error) {
    console.warn("[chat] generate failed:", error);
    return {
      text: config.chat.emptyReplyFallback,
      from: "fallback",
    };
  }
}
