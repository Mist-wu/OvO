import { config } from "../config";
import { DeepSeekClient } from "./deepseek_client";
import { GeminiClient } from "./gemini_client";
import type { LlmClient } from "./types";

export function createLlmClientFromConfig(): LlmClient | null {
  if (config.llm.provider === "none") {
    return null;
  }

  if (config.llm.provider === "gemini") {
    return new GeminiClient({
      apiKey: config.llm.gemini.apiKey,
      model: config.llm.gemini.model,
      baseUrl: config.llm.gemini.baseUrl,
      timeoutMs: config.llm.timeoutMs,
    });
  }

  return new DeepSeekClient({
    apiKey: config.llm.deepseek.apiKey,
    model: config.llm.deepseek.model,
    baseUrl: config.llm.deepseek.baseUrl,
    timeoutMs: config.llm.timeoutMs,
  });
}

export function getLlmSetupSummary(): string {
  if (config.llm.provider === "none") {
    return "llm.provider=none (未启用)";
  }

  const provider = config.llm.provider;
  const model =
    provider === "gemini" ? config.llm.gemini.model : config.llm.deepseek.model;
  const configured =
    provider === "gemini"
      ? config.llm.gemini.apiKey.trim().length > 0
      : config.llm.deepseek.apiKey.trim().length > 0;

  return `llm.provider=${provider} model=${model} configured=${configured}`;
}
