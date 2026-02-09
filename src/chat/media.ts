import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "../config";
import type { MessageSegment } from "../napcat/message";
import type { ChatVisualInput } from "./types";

const ALLOWED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/bmp",
]);

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
};

function safeDataFieldString(data: Record<string, unknown> | undefined, key: string): string {
  if (!data) return "";
  const value = data[key];
  return typeof value === "string" ? value.trim() : "";
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function extractImageRefs(segments: MessageSegment[] | undefined): string[] {
  if (!Array.isArray(segments)) return [];

  const refs: string[] = [];
  for (const segment of segments) {
    if (segment.type !== "image") continue;
    const data = segment.data;
    refs.push(safeDataFieldString(data, "url"));
    refs.push(safeDataFieldString(data, "file"));
    refs.push(safeDataFieldString(data, "path"));
  }
  return uniqueValues(refs);
}

function normalizeMimeType(value: string | null | undefined): string {
  if (!value) return "";
  const normalized = value.toLowerCase().split(";")[0].trim();
  return ALLOWED_MIME_TYPES.has(normalized) ? normalized : "";
}

function inferMimeTypeFromRef(ref: string): string {
  const withoutQuery = ref.split("?")[0];
  const ext = path.extname(withoutQuery).toLowerCase();
  return MIME_BY_EXT[ext] ?? "image/jpeg";
}

function isHttpUrl(ref: string): boolean {
  return ref.startsWith("http://") || ref.startsWith("https://");
}

function parseDataUri(ref: string): { mimeType: string; dataBase64: string } | null {
  if (!ref.startsWith("data:")) return null;
  const matched = ref.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!matched) return null;
  const mimeType = normalizeMimeType(matched[1]);
  if (!mimeType) return null;
  const dataBase64 = matched[2].trim();
  if (!dataBase64) return null;
  return { mimeType, dataBase64 };
}

function parseBase64PseudoUri(ref: string): { mimeType: string; dataBase64: string } | null {
  if (!ref.startsWith("base64://")) return null;
  const dataBase64 = ref.slice("base64://".length).trim();
  if (!dataBase64) return null;
  return {
    mimeType: "image/jpeg",
    dataBase64,
  };
}

function isLikelyLocalPath(ref: string): boolean {
  if (!ref) return false;
  if (ref.startsWith("file://")) return true;
  if (/^[a-zA-Z]:\\/.test(ref)) return true;
  if (ref.startsWith("/") || ref.startsWith("./") || ref.startsWith("../")) return true;
  return false;
}

function toFileSystemPath(ref: string): string {
  if (ref.startsWith("file://")) {
    return fileURLToPath(ref);
  }
  return ref;
}

async function resolveFromRemoteUrl(ref: string): Promise<ChatVisualInput | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.chat.mediaFetchTimeoutMs);
  try {
    const response = await fetch(ref, { signal: controller.signal });
    if (!response.ok) {
      return null;
    }

    const headerContentLength = response.headers.get("content-length");
    const contentLength = headerContentLength ? Number(headerContentLength) : NaN;
    if (Number.isFinite(contentLength) && contentLength > config.chat.mediaMaxBytes) {
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > config.chat.mediaMaxBytes) {
      return null;
    }

    const headerMime = normalizeMimeType(response.headers.get("content-type"));
    const mimeType = headerMime || inferMimeTypeFromRef(ref);
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return null;
    }

    return {
      source: ref,
      mimeType,
      dataBase64: buffer.toString("base64"),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveFromLocalPath(ref: string): Promise<ChatVisualInput | null> {
  const filePath = toFileSystemPath(ref);
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > config.chat.mediaMaxBytes) return null;

    const data = await fs.readFile(filePath);
    const mimeType = inferMimeTypeFromRef(filePath);
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      return null;
    }
    return {
      source: filePath,
      mimeType,
      dataBase64: data.toString("base64"),
    };
  } catch {
    return null;
  }
}

async function resolveSingleVisualInput(ref: string): Promise<ChatVisualInput | null> {
  const fromDataUri = parseDataUri(ref);
  if (fromDataUri) {
    return {
      source: "data-uri",
      mimeType: fromDataUri.mimeType,
      dataBase64: fromDataUri.dataBase64,
    };
  }

  const fromBase64PseudoUri = parseBase64PseudoUri(ref);
  if (fromBase64PseudoUri) {
    return {
      source: "base64-uri",
      mimeType: fromBase64PseudoUri.mimeType,
      dataBase64: fromBase64PseudoUri.dataBase64,
    };
  }

  if (isHttpUrl(ref)) {
    return resolveFromRemoteUrl(ref);
  }

  if (isLikelyLocalPath(ref)) {
    return resolveFromLocalPath(ref);
  }

  return null;
}

export function hasVisualSegments(segments: MessageSegment[] | undefined): boolean {
  if (!Array.isArray(segments)) return false;
  return segments.some((segment) => segment.type === "image");
}

export async function resolveVisualInputs(
  segments: MessageSegment[] | undefined,
): Promise<ChatVisualInput[]> {
  if (!config.chat.mediaEnabled) {
    return [];
  }

  const refs = extractImageRefs(segments);
  if (refs.length === 0) return [];

  const limitedRefs = refs.slice(0, config.chat.mediaMaxImages);
  const results: ChatVisualInput[] = [];
  for (const ref of limitedRefs) {
    const resolved = await resolveSingleVisualInput(ref);
    if (resolved) {
      results.push(resolved);
    }
  }
  return results;
}
