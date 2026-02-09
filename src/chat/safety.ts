import { config } from "../config";

export function sanitizeReply(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return config.chat.emptyReplyFallback;

  if (trimmed.length > config.chat.maxReplyChars) {
    return trimmed.slice(0, config.chat.maxReplyChars).trim();
  }

  return trimmed;
}
