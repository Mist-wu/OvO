import type { MessageSegment } from "./message";

type SegmentSummaryOptions = {
  skipReply?: boolean;
  includeForwardPlaceholder?: boolean;
  selfId?: number | string;
};

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatAtSummary(
  qq: unknown,
  options?: { selfId?: number | string },
): string {
  if (qq === "all") return "";
  if (typeof qq !== "number" && typeof qq !== "string") return "";
  const qqText = String(qq).trim();
  if (!qqText) return "";
  const selfIdText =
    typeof options?.selfId === "number" || typeof options?.selfId === "string"
      ? String(options.selfId)
      : "";
  if (selfIdText && qqText === selfIdText) {
    return "";
  }
  return "";
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
  const segments: MessageSegment[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    const normalized = normalizeWhitespace(text);
    if (normalized) {
      segments.push({
        type: "text",
        data: { text: normalized },
      });
    }
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
        segments.push({
          type: "image",
          data: {
            url: params.url ?? "",
            file: params.file ?? imageRef ?? "",
            path: params.path ?? "",
          },
        });
        break;
      }
      case "face":
      case "mface":
        segments.push({
          type,
          data: params as Record<string, unknown>,
        });
        break;
      case "at":
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
        break;
    }

    cursor = index + full.length;
  }

  if (cursor < raw.length) {
    pushText(raw.slice(cursor));
  }

  return {
    summary: summarizeMessageSegments(segments, { skipReply: true, selfId: options?.selfId }),
    segments,
  };
}

export function summarizeMessageSegments(
  segments: MessageSegment[],
  options?: SegmentSummaryOptions,
): string {
  const parts: string[] = [];

  for (const segment of segments) {
    if (segment.type === "text") {
      const text = segment.data?.text;
      if (typeof text === "string" && text.trim()) {
        parts.push(text.trim());
      }
      continue;
    }

    if (segment.type === "image") {
      parts.push("[图片]");
      continue;
    }

    if (segment.type === "face" || segment.type === "mface") {
      continue;
    }

    if (segment.type === "at") {
      parts.push(formatAtSummary(segment.data?.qq, { selfId: options?.selfId }));
      continue;
    }

    if (segment.type === "reply") {
      if (!options?.skipReply) {
        parts.push("[引用]");
      }
      continue;
    }

    if (segment.type === "forward") {
      parts.push(options?.includeForwardPlaceholder ? "[聊天记录]" : "[forward]");
      continue;
    }

    if (segment.type === "node") {
      parts.push(summarizeForwardNode(segment.data) || "[聊天记录节点]");
      continue;
    }

    parts.push(`[${segment.type}]`);
  }

  return normalizeWhitespace(parts.join(" "));
}

export function parseRawCqSegments(raw: string): MessageSegment[] {
  return parseRawCqMessage(raw).segments;
}

function summarizeForwardNode(data: Record<string, unknown> | undefined): string {
  if (!data) return "";

  const nickname =
    typeof data.nickname === "string" && data.nickname.trim() ? data.nickname.trim() : undefined;
  const content =
    summarizeMessageSegments(extractSegmentsFromUnknownMessage(data.content ?? data.message), {
      skipReply: true,
      includeForwardPlaceholder: true,
    }) ||
    (typeof data.content === "string" ? normalizeWhitespace(data.content) : "");

  if (!content) {
    return nickname ? `${nickname}: [聊天记录节点]` : "[聊天记录节点]";
  }

  return nickname ? `${nickname}: ${content}` : content;
}

export function extractSegmentsFromUnknownMessage(message: unknown): MessageSegment[] {
  if (Array.isArray(message)) {
    return message as MessageSegment[];
  }

  if (message && typeof message === "object" && "type" in message && "data" in message) {
    return [message as MessageSegment];
  }

  if (typeof message === "string") {
    return parseRawCqMessage(message).segments;
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
