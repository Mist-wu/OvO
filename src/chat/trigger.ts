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

function hasMeaningfulTextSegments(segments: MessageSegment[] | undefined): boolean {
  if (!Array.isArray(segments)) return false;
  return segments.some((segment) => {
    if (segment.type !== "text") return false;
    const content = segment.data?.text;
    return typeof content === "string" && content.trim().length > 0;
  });
}

function hasImageOnlyCqContent(raw: string): boolean {
  const regex = /\[CQ:([a-zA-Z0-9_]+)(?:,[^\]]+)?\]/g;
  let hasImage = false;
  let hasPlainText = false;
  let cursor = 0;

  for (const match of raw.matchAll(regex)) {
    const full = match[0] ?? "";
    const type = (match[1] ?? "").toLowerCase();
    const index = match.index ?? 0;

    if (index > cursor && raw.slice(cursor, index).trim()) {
      hasPlainText = true;
    }
    if (type === "image") {
      hasImage = true;
    }
    cursor = index + full.length;
  }

  if (cursor < raw.length && raw.slice(cursor).trim()) {
    hasPlainText = true;
  }

  return hasImage && !hasPlainText;
}

function isPrivateImageOnlyMessage(event: ChatEvent): boolean {
  if (Array.isArray(event.segments)) {
    const hasImage = event.segments.some((segment) => segment.type === "image");
    if (!hasImage) return false;
    return !hasMeaningfulTextSegments(event.segments);
  }

  if (typeof event.rawMessage === "string" && event.rawMessage.trim()) {
    return hasImageOnlyCqContent(event.rawMessage.trim());
  }

  return false;
}

export function decideTrigger(
  event: ChatEvent,
): TriggerDecision {
  const text = event.text.trim();
  const hasVisual = hasVisualSegments(event.segments);
  const hasContent = text.length > 0 || hasVisual;

  if (event.scope === "private") {
    if (isPrivateImageOnlyMessage(event)) {
      return {
        shouldReply: false,
        reason: "not_triggered",
        priority: "low",
        willingness: 0,
      };
    }

    if (!hasContent) {
      return {
        shouldReply: false,
        reason: "empty_text",
        priority: "low",
        willingness: 0,
      };
    }
    return {
      shouldReply: true,
      reason: "private_default",
      priority: "high",
      willingness: 0.95,
    };
  }

  if (hasAtSelf(event.segments, event.selfId)) {
    return {
      shouldReply: true,
      reason: "mentioned",
      priority: "must",
      willingness: 1,
    };
  }

  if (!hasContent) {
    return {
      shouldReply: false,
      reason: "empty_text",
      priority: "low",
      willingness: 0,
    };
  }

  return {
    shouldReply: false,
    reason: "not_triggered",
    priority: "low",
    willingness: 0,
  };
}
