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

type GeminiSdkClientOptions = {
  timeoutMs?: number;
};

function normalizeBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

export function createGeminiSdkClient(options?: GeminiSdkClientOptions): GoogleGenAI {
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
  signal?: AbortSignal;
}): Promise<string> {
  const normalizedSystemPrompt = input.systemPrompt?.trim() || "";
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("[llm] prompt is required");
  }

  const normalizedImages = input.inlineImages.filter((item) => {
    return Boolean(item?.mimeType && item?.dataBase64);
  });

  return runGeminiCall(normalizedSystemPrompt, normalizedPrompt, normalizedImages, input.signal);
}

async function runGeminiCall(
  normalizedSystemPrompt: string,
  normalizedPrompt: string,
  inlineImages: GeminiInlineImage[],
  signal?: AbortSignal,
): Promise<string> {
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
      const response = await client.models.generateContent({
        model: config.llm.gemini.model,
        contents: parts,
        ...(normalizedSystemPrompt
          ? {
              config: {
                systemInstruction: normalizedSystemPrompt,
              },
            }
          : {}),
      });

      const output = response.text?.trim();
      if (!output) {
        throw new Error("[llm] Gemini 返回空内容");
      }
      return output;
    },
  );
}

function resolveGeminiFallback(error: ExternalCallError): string {
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
    return "Gemini 服务暂时不可用，请稍后再试";
  }

  throw error;
}
