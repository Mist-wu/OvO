import type { MessageSegment } from "../napcat/message";
import { hasVisualSegments } from "./media";
import type { ChatEvent, TriggerDecision } from "./types";

function hasAtSelf(segments: MessageSegment[] | undefined, selfId: number | undefined): boolean {
  if (!Array.isArray(segments)) return false;
  if (typeof selfId !== "number") return false;

  return segments.some((segment) => {
    if (segment.type !== "at") return false;
    const qq = segment.data?.qq;
    if (typeof qq === "number") return qq === selfId;
    if (typeof qq === "string") {
      const numeric = Number(qq);
      return Number.isFinite(numeric) && numeric === selfId;
    }
    return false;
  });
}

function hasReplySegment(segments: MessageSegment[] | undefined): boolean {
  if (!Array.isArray(segments)) return false;
  return segments.some((segment) => segment.type === "reply");
}

function includesAlias(text: string, aliases: string[]): boolean {
  if (!text) return false;
  const normalizedText = text.toLowerCase();
  return aliases.some((alias) => {
    const normalizedAlias = alias.trim().toLowerCase();
    if (!normalizedAlias) return false;
    return normalizedText.includes(normalizedAlias);
  });
}

export function decideTrigger(event: ChatEvent, aliases: string[]): TriggerDecision {
  const text = event.text.trim();
  const hasVisual = hasVisualSegments(event.segments);
  const hasContent = text.length > 0 || hasVisual;

  if (event.scope === "private") {
    if (!hasContent) {
      return { shouldReply: false, reason: "empty_text" };
    }
    return { shouldReply: true, reason: "private_default" };
  }

  if (hasAtSelf(event.segments, event.selfId)) {
    return { shouldReply: true, reason: "mentioned" };
  }

  if (hasReplySegment(event.segments)) {
    return { shouldReply: true, reason: "replied_to_bot" };
  }

  if (includesAlias(text, aliases)) {
    return { shouldReply: true, reason: "named_bot" };
  }

  if (!hasContent) {
    return { shouldReply: false, reason: "empty_text" };
  }

  return { shouldReply: false, reason: "not_triggered" };
}
