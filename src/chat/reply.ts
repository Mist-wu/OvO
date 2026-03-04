import { isAbortError } from "../utils/helpers";
import { logger } from "../utils/logger";
import { askGeminiWithImages } from "../llm";
import { config } from "../config";
import { sanitizeReply } from "./safety";
import type { ChatReply, ChatVisualInput } from "./types";

type GenerateChatReplyInput = {
  systemPrompt?: string;
  prompt: string;
  visuals: ChatVisualInput[];
  grounding?: {
    enabled?: boolean;
  };
  signal?: AbortSignal;
  seed?: string;
};

export async function generateChatReply(input: GenerateChatReplyInput): Promise<ChatReply> {
  try {
    const raw =
      input.visuals.length > 0
        ? await askGeminiWithImages({
          systemPrompt: input.systemPrompt,
          prompt: input.prompt,
          inlineImages: input.visuals.map((item) => ({
            mimeType: item.mimeType,
            dataBase64: item.dataBase64,
          })),
          grounding: input.grounding,
          signal: input.signal,
        })
        : await askGeminiWithImages({
          systemPrompt: input.systemPrompt,
          prompt: input.prompt,
          inlineImages: [],
          grounding: input.grounding,
          signal: input.signal,
        });

    if (config.chat.groundingMetaLogEnabled && raw.grounding) {
      logger.info("[chat] grounding metadata", {
        usedSearch: raw.grounding.usedSearch,
        webSearchQueries: raw.grounding.webSearchQueries,
        sources: raw.grounding.sources,
      });
    }
    return {
      text: sanitizeReply(raw.text, { seed: input.seed }),
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
