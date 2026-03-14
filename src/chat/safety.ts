import { config } from "../config";
import { humanizeReply } from "./humanize";

function stripReplyArtifacts(text: string): string {
  return text
    .replace(/\[[^\]\r\n]*表情[^\]\r\n]*\]/g, " ")
    .replace(/@[^\s@，。！？、；：,.!?;:\]]+\.?/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeReply(raw: string, options?: { seed?: string }): string {
  const trimmed = raw.trim();
  if (!trimmed) return config.chat.emptyReplyFallback;

  const humanized = humanizeReply(trimmed, options);
  const normalized = stripReplyArtifacts(humanized).trim() || config.chat.emptyReplyFallback;

  if (normalized.length > config.chat.maxReplyChars) {
    return normalized.slice(0, config.chat.maxReplyChars).trim();
  }

  return normalized;
}
