export type LlmProviderName = "gemini" | "deepseek";

export type LlmMessageRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmMessageRole;
  content: string;
};

export type LlmGenerateOptions = {
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
};

export type LlmGenerateResult = {
  provider: LlmProviderName;
  model: string;
  text: string;
  raw: unknown;
};

export interface LlmClient {
  readonly provider: LlmProviderName;
  readonly model: string;
  readonly configured: boolean;
  generateText(messages: LlmMessage[], options?: LlmGenerateOptions): Promise<LlmGenerateResult>;
}
