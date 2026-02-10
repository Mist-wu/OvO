import { config } from "../config";
import { runExternalCall, type ExternalCallError } from "./external_call";

type SearchTopic = {
  Text?: string;
  FirstURL?: string;
  Topics?: SearchTopic[];
};

type SearchApiResponse = {
  AbstractText?: string;
  AbstractURL?: string;
  Heading?: string;
  Answer?: string;
  Results?: SearchTopic[];
  RelatedTopics?: SearchTopic[];
};

type SearchSnippet = {
  text: string;
  url?: string;
};

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function collectSnippets(topics: SearchTopic[] | undefined, limit: number): SearchSnippet[] {
  if (!Array.isArray(topics) || topics.length <= 0) return [];

  const output: SearchSnippet[] = [];
  const walk = (nodes: SearchTopic[]) => {
    for (const item of nodes) {
      if (output.length >= limit) return;
      const nested = Array.isArray(item.Topics) ? item.Topics : [];
      if (nested.length > 0) {
        walk(nested);
      }

      const text = normalizeText(item.Text);
      if (!text) continue;
      output.push({
        text,
        url: normalizeText(item.FirstURL) || undefined,
      });
    }
  };

  walk(topics);
  return output.slice(0, limit);
}

function formatSearchSummary(query: string, payload: SearchApiResponse): string {
  const heading = normalizeText(payload.Heading);
  const abstractText = normalizeText(payload.AbstractText);
  const abstractUrl = normalizeText(payload.AbstractURL);
  const answer = normalizeText(payload.Answer);

  const snippets = [
    ...collectSnippets(payload.Results, 3),
    ...collectSnippets(payload.RelatedTopics, 4),
  ].slice(0, 4);

  const lines: string[] = [];
  lines.push(`搜索词：${query}`);

  if (heading) {
    lines.push(`主题：${heading}`);
  }
  if (answer) {
    lines.push(`直答：${answer}`);
  }
  if (abstractText) {
    lines.push(`摘要：${abstractText}`);
  }
  if (abstractUrl) {
    lines.push(`来源：${abstractUrl}`);
  }

  if (snippets.length > 0) {
    lines.push("候选网页：");
    snippets.forEach((item, index) => {
      if (item.url) {
        lines.push(`${index + 1}. ${item.text} (${item.url})`);
      } else {
        lines.push(`${index + 1}. ${item.text}`);
      }
    });
  }

  if (lines.length <= 1) {
    throw new Error("[search] no useful results");
  }

  return lines.join("\n");
}

export async function fetchWebSearchSummary(query: string): Promise<string> {
  const normalizedQuery = query.replace(/\s+/g, " ").trim();
  if (!normalizedQuery) {
    throw new Error("[search] query is required");
  }

  const circuitBreaker = {
    enabled: config.external.circuitBreakerEnabled,
    key: "search",
    failureThreshold: config.external.circuitFailureThreshold,
    openMs: config.external.circuitOpenMs,
  };

  const payload = await runExternalCall<SearchApiResponse | string>(
    {
      service: "search",
      operation: "duckduckgo_instant_answer",
      timeoutMs: config.search.timeoutMs,
      retries: config.external.search.retries,
      retryDelayMs: config.external.search.retryDelayMs,
      concurrency: config.external.search.concurrency,
      circuitBreaker,
      fallback: (error) => resolveSearchFallback(error),
    },
    async ({ signal }) => {
      const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(normalizedQuery)}&format=json&no_html=1&skip_disambig=1&kl=cn-zh`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal,
      });
      if (!response.ok) {
        throw new Error(`[search] request failed status=${response.status}`);
      }
      return (await response.json()) as SearchApiResponse;
    },
  );

  if (typeof payload === "string") {
    return payload;
  }

  return formatSearchSummary(normalizedQuery, payload);
}

function resolveSearchFallback(error: ExternalCallError): string {
  if (!config.external.search.degradeOnFailure) {
    throw error;
  }

  if (error.reason === "circuit_open" || error.retryable) {
    return "搜索服务暂时不可用，请稍后重试";
  }

  throw error;
}
