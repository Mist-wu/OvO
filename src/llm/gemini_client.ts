import { postJson, trimTrailingSlash } from "./http";
import type { LlmClient, LlmGenerateOptions, LlmGenerateResult, LlmMessage } from "./types";

type GeminiClientOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

export class GeminiClient implements LlmClient {
  readonly provider = "gemini" as const;

  constructor(private readonly options: GeminiClientOptions) {}

  get model(): string {
    return this.options.model;
  }

  get configured(): boolean {
    return this.options.apiKey.trim().length > 0;
  }

  async generateText(
    messages: LlmMessage[],
    options: LlmGenerateOptions = {},
  ): Promise<LlmGenerateResult> {
    if (!this.configured) {
      throw new Error("[llm] Gemini 未配置：请在 .env 中设置 GEMINI_API_KEY");
    }

    const contents = messages
      .filter((item) => item.role !== "system")
      .map((item) => ({
        role: item.role === "assistant" ? "model" : "user",
        parts: [{ text: item.content }],
      }));

    if (contents.length === 0) {
      throw new Error("[llm] Gemini 请求至少需要一条 user/assistant 消息");
    }

    const systemText = messages
      .filter((item) => item.role === "system")
      .map((item) => item.content)
      .join("\n\n")
      .trim();

    const generationConfig: Record<string, number> = {};
    if (typeof options.temperature === "number") {
      generationConfig.temperature = options.temperature;
    }
    if (typeof options.maxOutputTokens === "number") {
      generationConfig.maxOutputTokens = Math.max(1, Math.floor(options.maxOutputTokens));
    }

    const body: Record<string, unknown> = {
      contents,
    };
    if (systemText) {
      body.systemInstruction = {
        parts: [{ text: systemText }],
      };
    }
    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig;
    }

    const baseUrl = trimTrailingSlash(this.options.baseUrl);
    const model = encodeURIComponent(this.options.model);
    const apiKey = encodeURIComponent(this.options.apiKey);
    const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const raw = (await postJson(url, {
      body,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs,
    })) as GeminiResponse;

    const text = this.extractText(raw);
    if (!text) {
      throw new Error("[llm] Gemini 返回为空，未提取到文本结果");
    }

    return {
      provider: this.provider,
      model: this.model,
      text,
      raw,
    };
  }

  private extractText(response: GeminiResponse): string {
    const candidates = response.candidates ?? [];
    for (const candidate of candidates) {
      const parts = candidate.content?.parts ?? [];
      const merged = parts
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (merged) return merged;
    }
    return "";
  }
}
