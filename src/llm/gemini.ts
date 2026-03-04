import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";

import { config } from "../config";
import { runExternalCall, type ExternalCallError } from "../utils/external_call";

export type GeminiInlineImage = {
  mimeType: string;
  dataBase64: string;
};

export type GeminiGeneratedImage = {
  mimeType: string;
  dataBase64: string;
};

type GeminiGroundingSource = {
  title?: string;
  url?: string;
};

type GeminiGroundingMetadata = {
  webSearchQueries: string[];
  sources: GeminiGroundingSource[];
  usedSearch: boolean;
};

type GeminiTextResponse = {
  text: string;
  grounding?: GeminiGroundingMetadata;
};

type GeminiSdkClientOptions = {
  timeoutMs?: number;
};

type GeminiGroundingOptions = {
  enabled?: boolean;
};

type GeminiGenerateContentConfig = {
  systemInstruction?: string;
  tools?: Array<{ googleSearch: Record<string, never> }>;
};

function normalizeBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

function createGeminiSdkClient(options?: GeminiSdkClientOptions): GoogleGenAI {
  const apiKey = config.llm.gemini.apiKey.trim();
  if (!apiKey) {
    throw new Error("[llm] Gemini 未配置：请在 .env 中设置 GEMINI_API_KEY");
  }

  const baseUrl = normalizeBaseUrl(config.llm.gemini.baseUrl);
  const timeoutMs = options?.timeoutMs ?? config.llm.gemini.timeoutMs;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: timeoutMs,
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
}

export async function generateGeminiImageWithInputs(input: {
  prompt: string;
  inlineImages?: GeminiInlineImage[];
}): Promise<GeminiGeneratedImage> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("[llm] image prompt is required");
  }
  const inlineImages = Array.isArray(input.inlineImages)
    ? input.inlineImages.filter((item) => Boolean(item?.mimeType && item?.dataBase64))
    : [];

  return runExternalCall(
    {
      service: "gemini",
      operation: "generate_image",
      timeoutMs: config.llm.gemini.imageTimeoutMs,
      retries: config.external.gemini.retries,
      retryDelayMs: config.external.gemini.retryDelayMs,
      concurrency: config.external.gemini.concurrency,
      circuitBreaker: {
        enabled: config.external.circuitBreakerEnabled,
        key: "gemini:image",
        failureThreshold: config.external.circuitFailureThreshold,
        openMs: config.external.circuitOpenMs,
      },
    },
    async () => {
      const client = createGeminiSdkClient({
        timeoutMs: config.llm.gemini.imageTimeoutMs,
      });
      const response = await client.models.generateContent({
        model: config.llm.gemini.imageModel,
        contents: [
          createPartFromText(normalizedPrompt),
          ...inlineImages.map((item) => createPartFromBase64(item.dataBase64, item.mimeType)),
        ],
      });
      const candidates = Array.isArray(response.candidates) ? response.candidates : [];
      for (const candidate of candidates) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
          const dataBase64 = typeof part?.inlineData?.data === "string" ? part.inlineData.data.trim() : "";
          if (!dataBase64) continue;
          const mimeType = typeof part.inlineData?.mimeType === "string" && part.inlineData.mimeType.trim()
            ? part.inlineData.mimeType.trim()
            : "image/png";
          return { mimeType, dataBase64 };
        }
      }

      const fallbackDataBase64 = typeof response.data === "string" ? response.data.trim() : "";
      if (fallbackDataBase64) {
        const firstMimeType = candidates[0]?.content?.parts?.[0]?.inlineData?.mimeType;
        const mimeType = typeof firstMimeType === "string" && firstMimeType.trim()
          ? firstMimeType.trim()
          : "image/png";
        return { mimeType, dataBase64: fallbackDataBase64 };
      }

      throw new Error("[llm] Gemini 未返回图片");
    },
  );
}

export async function askGeminiWithImages(input: {
  systemPrompt?: string;
  prompt: string;
  inlineImages: GeminiInlineImage[];
  grounding?: GeminiGroundingOptions;
  signal?: AbortSignal;
}): Promise<GeminiTextResponse> {
  const normalizedSystemPrompt = input.systemPrompt?.trim() || "";
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("[llm] prompt is required");
  }

  const normalizedImages = input.inlineImages.filter((item) => {
    return Boolean(item?.mimeType && item?.dataBase64);
  });

  return runGeminiCall(
    normalizedSystemPrompt,
    normalizedPrompt,
    normalizedImages,
    Boolean(input.grounding?.enabled),
    input.signal,
  );
}

async function runGeminiCall(
  normalizedSystemPrompt: string,
  normalizedPrompt: string,
  inlineImages: GeminiInlineImage[],
  enableGrounding: boolean,
  signal?: AbortSignal,
): Promise<GeminiTextResponse> {
  const circuitBreaker = {
    enabled: config.external.circuitBreakerEnabled,
    key: "gemini",
    failureThreshold: config.external.circuitFailureThreshold,
    openMs: config.external.circuitOpenMs,
  };

  return runExternalCall(
    {
      service: "gemini",
      operation: "generate_content",
      timeoutMs: config.llm.gemini.timeoutMs,
      signal,
      retries: config.external.gemini.retries,
      retryDelayMs: config.external.gemini.retryDelayMs,
      concurrency: config.external.gemini.concurrency,
      circuitBreaker,
      fallback: (error) => resolveGeminiFallback(error),
    },
    async () => {
      const client = createGeminiSdkClient();
      const parts = [
        createPartFromText(normalizedPrompt),
        ...inlineImages.map((item) => createPartFromBase64(item.dataBase64, item.mimeType)),
      ];
      const requestConfig = buildGeminiGenerateContentConfig({
        systemPrompt: normalizedSystemPrompt,
        enableGrounding,
      });
      const response = await client.models.generateContent({
        model: config.llm.gemini.model,
        contents: parts,
        ...(requestConfig ? { config: requestConfig } : {}),
      });

      const output = response.text?.trim();
      if (!output) {
        throw new Error("[llm] Gemini 返回空内容");
      }
      return {
        text: output,
        grounding: extractGeminiGroundingMetadataFromResponse(response),
      };
    },
  );
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function toUniqueStrings(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = asNonEmptyString(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function toUniqueSources(values: unknown): GeminiGroundingSource[] {
  if (!Array.isArray(values)) return [];
  const seen = new Set<string>();
  const result: GeminiGroundingSource[] = [];
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const web = (item as { web?: unknown }).web;
    if (!web || typeof web !== "object") continue;
    const title = asNonEmptyString((web as { title?: unknown }).title);
    const url = asNonEmptyString((web as { uri?: unknown; url?: unknown }).uri)
      ?? asNonEmptyString((web as { uri?: unknown; url?: unknown }).url);
    if (!title && !url) continue;
    const key = `${title ?? ""}|${url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ title, url });
  }
  return result;
}

export function buildGeminiGenerateContentConfig(input: {
  systemPrompt?: string;
  enableGrounding?: boolean;
}): GeminiGenerateContentConfig | undefined {
  const systemPrompt = input.systemPrompt?.trim() || "";
  const config: GeminiGenerateContentConfig = {};

  if (systemPrompt) {
    config.systemInstruction = systemPrompt;
  }
  if (input.enableGrounding) {
    config.tools = [{ googleSearch: {} }];
  }

  if (!config.systemInstruction && !config.tools) {
    return undefined;
  }
  return config;
}

export function extractGeminiGroundingMetadataFromResponse(
  response: unknown,
): GeminiGroundingMetadata | undefined {
  if (!response || typeof response !== "object") return undefined;
  const candidates = (response as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates) || candidates.length <= 0) return undefined;
  const first = candidates[0];
  if (!first || typeof first !== "object") return undefined;

  const groundingMetadata = (first as { groundingMetadata?: unknown }).groundingMetadata;
  if (!groundingMetadata || typeof groundingMetadata !== "object") return undefined;

  const webSearchQueries = toUniqueStrings(
    (groundingMetadata as { webSearchQueries?: unknown }).webSearchQueries,
  );
  const sources = toUniqueSources(
    (groundingMetadata as { groundingChunks?: unknown }).groundingChunks,
  );
  return {
    webSearchQueries,
    sources,
    usedSearch: webSearchQueries.length > 0 || sources.length > 0,
  };
}

function resolveGeminiFallback(error: ExternalCallError): GeminiTextResponse {
  const cause = error.cause;
  if (cause instanceof Error && cause.name === "AbortError") {
    throw cause;
  }
  if (cause instanceof Error && cause.message.includes("GEMINI_API_KEY")) {
    throw cause;
  }

  if (!config.external.gemini.degradeOnFailure) {
    throw error;
  }

  if (error.reason === "circuit_open" || error.retryable) {
    return { text: "Gemini 服务暂时不可用，请稍后再试" };
  }

  throw error;
}
