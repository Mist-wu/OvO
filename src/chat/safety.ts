import { config } from "../config";
import { humanizeReply } from "./humanize";

export function sanitizeReply(raw: string, options?: { seed?: string }): string {
  const trimmed = raw.trim();
  if (!trimmed) return config.chat.emptyReplyFallback;

  const humanized = humanizeReply(trimmed, options);
  const normalized = humanized.trim() || config.chat.emptyReplyFallback;

  if (normalized.length > config.chat.maxReplyChars) {
    return normalized.slice(0, config.chat.maxReplyChars).trim();
  }

  return normalized;
}
