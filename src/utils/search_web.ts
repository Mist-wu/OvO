import { config } from "../config";
import { ExternalCallError, runExternalCall } from "./external_call";

type DuckTopic = {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckTopic[];
};

type DuckResponse = {
  Heading?: string;
  AbstractText?: string;
  AbstractURL?: string;
  RelatedTopics?: DuckTopic[];
};

export type WebSearchItem = {
  title: string;
  snippet: string;
  url: string;
  source: string;
};

function normalizeText(value: string, fallback = ""): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || fallback;
}

function clipText(value: string, maxLength: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

function pushItem(
  target: WebSearchItem[],
  item: WebSearchItem,
  seen: Set<string>,
  maxResults: number,
): void {
  if (target.length >= maxResults) return;
  if (!item.url) return;
  const key = item.url.trim();
  if (!key || seen.has(key)) return;
  seen.add(key);
  target.push(item);
}

function flattenTopics(topics: DuckTopic[] | undefined): Array<{ text: string; url: string }> {
  if (!topics || topics.length <= 0) return [];
  const result: Array<{ text: string; url: string }> = [];
  const stack = topics.slice();
  while (stack.length > 0) {
    const current = stack.shift() as DuckTopic;
    if (Array.isArray(current.Topics) && current.Topics.length > 0) {
      stack.push(...current.Topics);
      continue;
    }
    const text = normalizeText(current.Text ?? "");
    const url = normalizeText(current.FirstURL ?? "");
    if (text && url) {
      result.push({ text, url });
    }
  }
  return result;
}

async function fetchDuckDuckGo(query: string, signal: AbortSignal): Promise<WebSearchItem[]> {
  const response = await fetch(
    `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`[search] duckduckgo status=${response.status}`);
  }
  const payload = (await response.json()) as DuckResponse;
  const seen = new Set<string>();
  const items: WebSearchItem[] = [];
  const maxResults = Math.max(1, Math.floor(config.search.maxResults));

  if (payload.AbstractText && payload.AbstractURL) {
    pushItem(
      items,
      {
        title: clipText(payload.Heading || query, 80),
        snippet: clipText(payload.AbstractText, 180),
        url: payload.AbstractURL,
        source: "DuckDuckGo",
      },
      seen,
      maxResults,
    );
  }

  for (const topic of flattenTopics(payload.RelatedTopics)) {
    pushItem(
      items,
      {
        title: clipText(topic.text.split(" - ")[0] || topic.text, 80),
        snippet: clipText(topic.text, 180),
        url: topic.url,
        source: "DuckDuckGo",
      },
      seen,
      maxResults,
    );
    if (items.length >= maxResults) {
      break;
    }
  }

  return items;
}

async function fetchWikipedia(query: string, signal: AbortSignal): Promise<WebSearchItem[]> {
  const response = await fetch(
    `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=5&namespace=0&format=json`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`[search] wikipedia status=${response.status}`);
  }
  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload) || payload.length < 4) {
    return [];
  }

  const titles = Array.isArray(payload[1]) ? payload[1] : [];
  const snippets = Array.isArray(payload[2]) ? payload[2] : [];
  const urls = Array.isArray(payload[3]) ? payload[3] : [];
  const maxResults = Math.max(1, Math.floor(config.search.maxResults));
  const seen = new Set<string>();
  const items: WebSearchItem[] = [];

  const total = Math.min(titles.length, snippets.length, urls.length, maxResults);
  for (let index = 0; index < total; index += 1) {
    const title = normalizeText(String(titles[index] ?? ""));
    const snippet = normalizeText(String(snippets[index] ?? ""));
    const url = normalizeText(String(urls[index] ?? ""));
    if (!title || !url) continue;
    pushItem(
      items,
      {
        title: clipText(title, 80),
        snippet: clipText(snippet || "维基百科词条", 180),
        url,
        source: "Wikipedia",
      },
      seen,
      maxResults,
    );
  }

  return items;
}

export async function searchWeb(query: string): Promise<WebSearchItem[]> {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const maxResults = Math.max(1, Math.floor(config.search.maxResults));
  const circuitBreaker = {
    enabled: config.external.circuitBreakerEnabled,
    key: "search",
    failureThreshold: config.external.circuitFailureThreshold,
    openMs: config.external.circuitOpenMs,
  };

  const payload = await runExternalCall<WebSearchItem[] | string>(
    {
      service: "search",
      operation: "web_query",
      timeoutMs: config.search.timeoutMs,
      retries: config.external.search.retries,
      retryDelayMs: config.external.search.retryDelayMs,
      concurrency: config.external.search.concurrency,
      circuitBreaker,
      fallback: (error) => resolveSearchFallback(error),
    },
    async ({ signal }) => {
      const [duck, wiki] = await Promise.allSettled([
        fetchDuckDuckGo(normalizedQuery, signal),
        fetchWikipedia(normalizedQuery, signal),
      ]);
      const merged: WebSearchItem[] = [];
      const seen = new Set<string>();

      if (duck.status === "fulfilled") {
        for (const item of duck.value) {
          pushItem(merged, item, seen, maxResults);
        }
      }
      if (wiki.status === "fulfilled") {
        for (const item of wiki.value) {
          pushItem(merged, item, seen, maxResults);
        }
      }

      if (merged.length <= 0) {
        throw new Error("[search] no_results");
      }
      return merged.slice(0, maxResults);
    },
  );

  if (typeof payload === "string") {
    return [
      {
        title: "搜索降级提示",
        snippet: payload,
        url: "https://duckduckgo.com",
        source: "fallback",
      },
    ];
  }

  return payload;
}

export function formatSearchContext(query: string, items: WebSearchItem[]): string {
  const lines = [
    "工具结果（实时网页搜索）",
    `查询：${query}`,
  ];

  if (items.length <= 0) {
    lines.push("未检索到有效网页结果。");
    return lines.join("\n");
  }

  lines.push("检索结果：");
  items.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.title}`);
    lines.push(`   来源：${item.source}`);
    lines.push(`   链接：${item.url}`);
    lines.push(`   摘要：${item.snippet}`);
  });
  lines.push("回答时优先引用检索结果，无法确认的内容请明确说明不确定。");
  return lines.join("\n");
}

function resolveSearchFallback(error: ExternalCallError): WebSearchItem[] | string {
  if (!config.external.search.degradeOnFailure) {
    throw error;
  }
  if (error.reason === "circuit_open" || error.retryable) {
    return "搜索服务暂时不可用，请稍后重试";
  }
  return "未找到稳定网页结果，可先基于已有知识回答";
}
