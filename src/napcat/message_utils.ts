import type { MessageSegment } from "./message";

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAtSummary(
  qq: unknown,
  options?: { selfId?: number | string },
): string {
  if (qq === "all") return "@全体成员";
  if (typeof qq !== "number" && typeof qq !== "string") return "@成员";
  const qqText = String(qq).trim();
  if (!qqText) return "@成员";
  const selfIdText =
    typeof options?.selfId === "number" || typeof options?.selfId === "string"
      ? String(options.selfId)
      : "";
  if (selfIdText && qqText === selfIdText) {
    return "";
  }
  return "@成员";
}

export function parseCqParams(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [key, ...rest] = pair.split("=");
    if (!key) continue;
    result[key.trim()] = rest.join("=").trim();
  }
  return result;
}

export function parseRawCqMessage(
  raw: string,
  options?: { selfId?: number | string },
): { summary: string; segments: MessageSegment[] } {
  const regex = /\[CQ:([a-zA-Z0-9_]+)(?:,([^\]]+))?\]/g;
  const summaryParts: string[] = [];
  const segments: MessageSegment[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    const normalized = normalizeWhitespace(text);
    if (normalized) summaryParts.push(normalized);
  };

  for (const match of raw.matchAll(regex)) {
    const full = match[0] ?? "";
    const type = (match[1] ?? "").toLowerCase();
    const params = parseCqParams(match[2]);
    const index = match.index ?? 0;

    if (index > cursor) {
      pushText(raw.slice(cursor, index));
    }

    switch (type) {
      case "image": {
        const imageRef = params.url || params.file || params.path;
        if (imageRef) {
          segments.push({
            type: "image",
            data: {
              url: params.url ?? "",
              file: params.file ?? imageRef,
              path: params.path ?? "",
            },
          });
        }
        summaryParts.push("[图片]");
        break;
      }
      case "face":
      case "mface":
        summaryParts.push("[表情]");
        break;
      case "at":
        summaryParts.push(formatAtSummary(params.qq, options));
        segments.push({
          type: "at",
          data: params as Record<string, unknown>,
        });
        break;
      case "reply":
        segments.push({
          type: "reply",
          data: params as Record<string, unknown>,
        });
        break;
      default:
        segments.push({
          type,
          data: params as Record<string, unknown>,
        });
        summaryParts.push(`[${type}]`);
        break;
    }

    cursor = index + full.length;
  }

  if (cursor < raw.length) {
    pushText(raw.slice(cursor));
  }

  return {
    summary: normalizeWhitespace(summaryParts.join(" ")),
    segments,
  };
}

export function parseRawCqSegments(raw: string): MessageSegment[] {
  return parseRawCqMessage(raw).segments;
}

export function extractSegmentsFromUnknownMessage(message: unknown): MessageSegment[] {
  if (Array.isArray(message)) {
    return message as MessageSegment[];
  }

  if (message && typeof message === "object" && "type" in message && "data" in message) {
    return [message as MessageSegment];
  }

  if (typeof message === "string") {
    return parseRawCqSegments(message);
  }

  return [];
}

function getSegmentIdByType(
  segments: MessageSegment[] | undefined,
  type: string,
): number | string | undefined {
  if (!Array.isArray(segments)) return undefined;

  for (const segment of segments) {
    if (segment.type !== type) continue;
    const id = (segment.data as Record<string, unknown> | undefined)?.id;
    if (typeof id === "number" || typeof id === "string") {
      return id;
    }
  }

  return undefined;
}

export function getReplySegmentId(
  segments: MessageSegment[] | undefined,
): number | string | undefined {
  return getSegmentIdByType(segments, "reply");
}

export function getForwardSegmentId(
  segments: MessageSegment[] | undefined,
): number | string | undefined {
  return getSegmentIdByType(segments, "forward");
}

export function getSenderNameFromUnknown(sender: unknown): string | undefined {
  if (!sender || typeof sender !== "object") return undefined;

  const parsed = sender as { card?: unknown; nickname?: unknown };
  if (typeof parsed.card === "string" && parsed.card.trim()) {
    return parsed.card.trim();
  }
  if (typeof parsed.nickname === "string" && parsed.nickname.trim()) {
    return parsed.nickname.trim();
  }

  return undefined;
}
