import { askGemini, askGeminiWithImages } from "../llm";
import { config } from "../config";
import { sanitizeReply } from "./safety";
import type { ChatReply, ChatVisualInput } from "./types";

type GenerateChatReplyInput = {
  prompt: string;
  visuals: ChatVisualInput[];
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
          })
        : await askGemini(input.prompt);
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
