import { postJson, trimTrailingSlash } from "./http";
import type { LlmClient, LlmGenerateOptions, LlmGenerateResult, LlmMessage } from "./types";

type DeepSeekClientOptions = {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
};

type DeepSeekResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
};

export class DeepSeekClient implements LlmClient {
  readonly provider = "deepseek" as const;

  constructor(private readonly options: DeepSeekClientOptions) {}

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
      throw new Error("[llm] DeepSeek 未配置：请在 .env 中设置 DEEPSEEK_API_KEY");
    }

    const chatMessages = messages.map((item) => ({
      role: item.role,
      content: item.content,
    }));

    if (chatMessages.length === 0) {
      throw new Error("[llm] DeepSeek 请求至少需要一条消息");
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages: chatMessages,
    };
    if (typeof options.temperature === "number") {
      body.temperature = options.temperature;
    }
    if (typeof options.maxOutputTokens === "number") {
      body.max_tokens = Math.max(1, Math.floor(options.maxOutputTokens));
    }

    const url = `${trimTrailingSlash(this.options.baseUrl)}/chat/completions`;
    const raw = (await postJson(url, {
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body,
      timeoutMs: options.timeoutMs ?? this.options.timeoutMs,
    })) as DeepSeekResponse;

    const text = this.extractText(raw);
    if (!text) {
      throw new Error("[llm] DeepSeek 返回为空，未提取到文本结果");
    }

    return {
      provider: this.provider,
      model: this.model,
      text,
      raw,
    };
  }

  private extractText(response: DeepSeekResponse): string {
    const choices = response.choices ?? [];
    for (const choice of choices) {
      const content = choice.message?.content;
      if (typeof content === "string" && content.trim()) {
        return content.trim();
      }
    }
    return "";
  }
}
