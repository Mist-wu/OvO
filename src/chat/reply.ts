import { isAbortError } from "../utils/helpers";
import { logger } from "../utils/logger";
import { askGeminiWithImages } from "../llm";
import { config } from "../config";
import { sanitizeReply } from "./safety";
import type { ChatReply, ChatVisualInput } from "./types";

type GenerateChatReplyInput = {
  prompt: string;
  visuals: ChatVisualInput[];
  signal?: AbortSignal;
  seed?: string;
};

export async function generateChatReply(input: GenerateChatReplyInput): Promise<ChatReply> {
  try {
    const raw =
      input.visuals.length > 0
        ? await askGeminiWithImages({
          prompt: input.prompt,
          inlineImages: input.visuals.map((item) => ({
            mimeType: item.mimeType,
            dataBase64: item.dataBase64,
          })),
          signal: input.signal,
        })
        : await askGeminiWithImages({
          prompt: input.prompt,
          inlineImages: [],
          signal: input.signal,
        });
    return {
      text: sanitizeReply(raw, { seed: input.seed }),
      from: "llm",
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    logger.warn("[chat] generate failed:", error);
    return {
      text: config.chat.emptyReplyFallback,
      from: "fallback",
    };
  }
}
