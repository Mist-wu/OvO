import { clipText } from "../utils/helpers";
import { config } from "../config";
import { buildPrompt, type BuildContextInput } from "./context_builder";

export type ChatContextTransformer = (
  input: BuildContextInput,
  signal?: AbortSignal,
) => Promise<BuildContextInput> | BuildContextInput;

export type ChatContextConverter = (
  input: BuildContextInput,
) => Promise<string> | string;

export type ChatContextPipelineOptions = {
  transformers?: ChatContextTransformer[];
  converter?: ChatContextConverter;
};

export type ChatContextPipeline = {
  run: (input: BuildContextInput, signal?: AbortSignal) => Promise<string>;
};

function createAbortError(): Error {
  const error = new Error("[chat] context pipeline aborted");
  error.name = "AbortError";
  return error;
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function sanitizeHistory(
  history: BuildContextInput["history"],
  maxItems: number,
): BuildContextInput["history"] {
  if (history.length <= maxItems) {
    return history.map((item) => ({
      ...item,
      text: clipText(item.text, 600),
    }));
  }
  return history.slice(-maxItems).map((item) => ({
    ...item,
    text: clipText(item.text, 600),
  }));
}

function sanitizeStringList(values: string[], maxItems: number, maxLength: number): string[] {
  const deduped = Array.from(
    new Set(
      values
        .map((item) => item.replace(/\s+/g, " ").trim())
        .filter(Boolean),
    ),
  );
  return deduped.slice(0, maxItems).map((item) => clipText(item, maxLength));
}

export const defaultChatContextTransformer: ChatContextTransformer = async (input, signal) => {
  ensureNotAborted(signal);

  const maxHistoryItems = Math.max(4, config.chat.maxSessionMessages);
  const maxSummaryItems = Math.max(1, config.chat.summaryContextCount);
  const maxFactItems = Math.max(1, config.chat.memoryContextFactCount);

  const transformed: BuildContextInput = {
    ...input,
    userText: clipText(input.userText, 800),
    toolContext: input.toolContext ? clipText(input.toolContext, 2600) : input.toolContext,
    history: sanitizeHistory(input.history, maxHistoryItems),
    archivedSummaries: sanitizeStringList(input.archivedSummaries, maxSummaryItems, 260),
    longTermFacts: sanitizeStringList(input.longTermFacts, maxFactItems, 140),
  };

  ensureNotAborted(signal);
  return transformed;
};

export const defaultChatContextConverter: ChatContextConverter = (input) => buildPrompt(input);

export function createChatContextPipeline(options?: ChatContextPipelineOptions): ChatContextPipeline {
  const transformers = options?.transformers?.length
    ? options.transformers.slice()
    : [defaultChatContextTransformer];
  const converter = options?.converter ?? defaultChatContextConverter;

  return {
    async run(input: BuildContextInput, signal?: AbortSignal): Promise<string> {
      let transformed = input;
      for (const transformer of transformers) {
        ensureNotAborted(signal);
        transformed = await transformer(transformed, signal);
      }
      ensureNotAborted(signal);
      const converted = await converter(transformed);
      ensureNotAborted(signal);
      return converted;
    },
  };
}
