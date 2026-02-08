import { GoogleGenAI } from "@google/genai";

import { config } from "../config";
import { runExternalCall } from "../utils/external_call";

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
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    throw new Error("[llm] prompt is required");
  }

  return runExternalCall(
    {
      service: "gemini",
      operation: "generate_content",
      timeoutMs: config.llm.gemini.timeoutMs,
      retries: 1,
      retryDelayMs: 200,
      concurrency: 2,
    },
    async () => {
      const client = createGeminiSdkClient();
      const response = await client.models.generateContent({
        model: getGeminiModel(),
        contents: normalizedPrompt,
      });

      const output = response.text?.trim();
      if (!output) {
        throw new Error("[llm] Gemini 返回空内容");
      }
      return output;
    },
  );
}
