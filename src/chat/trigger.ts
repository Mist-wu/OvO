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

function isLikelyUnfinishedText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return true;

  if (/[，,、….]$/.test(normalized)) return true;
  if (/(然后|还有|以及|就是|但是|另外)$/.test(normalized)) return true;
  if (normalized.length <= 12 && !/[。！？!?]$/.test(normalized)) return true;
  return false;
}

function getPrivateWaitMs(text: string, hasVisual: boolean): number {
  if (!text.trim() && hasVisual) return 350;
  return isLikelyUnfinishedText(text) ? 800 : 220;
}

export function decideTrigger(
  event: ChatEvent,
): TriggerDecision {
  const text = event.text.trim();
  const hasVisual = hasVisualSegments(event.segments);
  const hasContent = text.length > 0 || hasVisual;

  if (event.scope === "private") {
    if (!hasContent) {
      return {
        shouldReply: false,
        reason: "empty_text",
        priority: "low",
        waitMs: 0,
        willingness: 0,
      };
    }
    return {
      shouldReply: true,
      reason: "private_default",
      priority: "high",
      waitMs: getPrivateWaitMs(text, hasVisual),
      willingness: 0.95,
    };
  }

  if (hasAtSelf(event.segments, event.selfId)) {
    return {
      shouldReply: true,
      reason: "mentioned",
      priority: "must",
      waitMs: 0,
      willingness: 1,
    };
  }

  if (!hasContent) {
    return {
      shouldReply: false,
      reason: "empty_text",
      priority: "low",
      waitMs: 0,
      willingness: 0,
    };
  }

  return {
    shouldReply: false,
    reason: "not_triggered",
    priority: "low",
    waitMs: 0,
    willingness: 0,
  };
}
