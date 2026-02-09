import { createPartFromBase64, createPartFromText, GoogleGenAI } from "@google/genai";

import { config } from "../config";
import { runExternalCall, type ExternalCallError } from "../utils/external_call";

export type GeminiInlineImage = {
  mimeType: string;
  dataBase64: string;
};

function normalizeBaseUrl(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\/+$/, "");
}

export function createGeminiSdkClient(): GoogleGenAI {
  const apiKey = config.llm.gemini.apiKey.trim();
  if (!apiKey) {
    throw new Error("[llm] Gemini 未配置：请在 .env 中设置 GEMINI_API_KEY");
  }

  const baseUrl = normalizeBaseUrl(config.llm.gemini.baseUrl);
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      timeout: config.llm.gemini.timeoutMs,
      ...(baseUrl ? { baseUrl } : {}),
    },
  });
}

export function getGeminiModel(): string {
  return config.llm.gemini.model;
}

export function getGeminiSetupSummary(): string {
  const configured = config.llm.gemini.apiKey.trim().length > 0;
  return `llm=gemini model=${config.llm.gemini.model} configured=${configured}`;
}

export async function askGemini(prompt: string): Promise<string> {
  return askGeminiWithImages({
    prompt,
    inlineImages: [],
  });
}

export async function askGeminiWithImages(input: {
  prompt: string;
  inlineImages: GeminiInlineImage[];
}): Promise<string> {
  const normalizedPrompt = input.prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("[llm] prompt is required");
  }

  const normalizedImages = input.inlineImages.filter((item) => {
    return Boolean(item?.mimeType && item?.dataBase64);
  });

  return runGeminiCall(normalizedPrompt, normalizedImages);
}

async function runGeminiCall(
  normalizedPrompt: string,
  inlineImages: GeminiInlineImage[],
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
        model: getGeminiModel(),
        contents: parts,
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
