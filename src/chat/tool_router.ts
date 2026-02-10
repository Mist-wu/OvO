import { config } from "../config";
import { fetchWebSearchSummary } from "../utils/search";
import { fetchWeatherSummary } from "../utils/weather";
import type { ChatEvent } from "./types";

export type ToolRouteResult =
  | { type: "none" }
  | { type: "direct"; tool: "weather" | "search"; text: string }
  | { type: "context"; tool: "search"; contextText: string; fallbackText: string };

const WEATHER_CITY_BLACKLIST = new Set([
  "今天",
  "明天",
  "后天",
  "最近",
  "现在",
  "这里",
  "这儿",
  "本地",
  "当地",
  "国内",
  "国外",
  "全国",
]);

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

function stripLeadingWords(input: string): string {
  return input
    .replace(/^(?:帮我|麻烦|请|你能|你可以|能不能|可以|帮忙|我想知道|我想问下)\s*/i, "")
    .trim();
}

function stripTrailingWords(input: string): string {
  return input
    .replace(/[？?！!。,.，]+$/g, "")
    .replace(/(?:怎么样|如何|咋样|好吗|可以吗|行吗|呢|吗)$/g, "")
    .trim();
}

function normalizeLocation(raw: string): string {
  const normalized = stripTrailingWords(normalizeText(raw));
  if (!normalized) return "";
  return normalized.slice(0, 24);
}

export function detectWeatherLocation(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return undefined;
  if (!/(天气|气温|温度|天气预报|下雨|降雨)/.test(normalized)) return undefined;
  const hasIntentCue =
    /[?？]/.test(normalized) ||
    /(查|搜|看看|看下|想知道|问下|预报|几度|多少度|冷不冷|热不热|下雨|会不会下雨|怎么样|如何|咋样|吗)/.test(
      normalized,
    ) ||
    /^[^\s，。！？?]{2,24}(?:天气|天气预报)$/i.test(normalized);
  if (!hasIntentCue) return undefined;

  const patterns = [
    /(?:查|搜|看看|看下|问下|想知道|帮我查)?\s*([^\s，。！？?]{2,24})\s*(?:天气|气温|温度|天气预报)(?:怎么样|如何|咋样|呢|吗)?[？?]?$/i,
    /(?:天气|天气预报)\s*(?:[:：]|\s)\s*([^\s，。！？?]{2,24})$/i,
    /^([^\s，。！？?]{2,24})\s*(?:天气|天气预报)(?:怎么样|如何|咋样|呢|吗)?[？?]?$/i,
  ];

  for (const pattern of patterns) {
    const matched = normalized.match(pattern);
    if (!matched) continue;
    const location = normalizeLocation(matched[1] ?? "");
    if (!location) continue;
    if (WEATHER_CITY_BLACKLIST.has(location)) continue;
    return location;
  }

  return undefined;
}

function normalizeSearchQuery(raw: string): string {
  const trimmed = stripTrailingWords(stripLeadingWords(normalizeText(raw)));
  return trimmed.replace(/^关于/, "").trim().slice(0, 120);
}

export function detectSearchQuery(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return undefined;

  const explicit = normalized.match(
    /^(?:帮我|麻烦|请|能不能|可以|帮忙)?\s*(?:搜索|搜一下|查一下|查查|帮我查|帮我搜|百度|google)\s*(.+)$/i,
  );
  if (explicit) {
    const query = normalizeSearchQuery(explicit[1] ?? "");
    return query || undefined;
  }

  const questionLike =
    /[?？]/.test(normalized) &&
    /(是什么|是谁|什么时候|哪里|哪一年|最新|新闻|百科|资料|信息|官网|价格|汇率|发布|定义|含义|历史)/.test(
      normalized,
    );
  if (!questionLike) return undefined;
  if (normalized.length < 4 || normalized.length > 120) return undefined;

  const query = normalizeSearchQuery(normalized);
  return query || undefined;
}

export async function routeChatTool(event: ChatEvent): Promise<ToolRouteResult> {
  const userText = normalizeText(event.text);
  if (!userText) return { type: "none" };

  const weatherLocation = detectWeatherLocation(userText);
  if (weatherLocation) {
    try {
      const report = await fetchWeatherSummary(weatherLocation);
      return {
        type: "direct",
        tool: "weather",
        text: report,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("WEATHER_API_KEY")) {
        return {
          type: "direct",
          tool: "weather",
          text: message,
        };
      }
      return {
        type: "direct",
        tool: "weather",
        text: "天气查询失败，请稍后重试",
      };
    }
  }

  if (!config.search.enabled) {
    return { type: "none" };
  }

  const searchQuery = detectSearchQuery(userText);
  if (!searchQuery) {
    return { type: "none" };
  }

  let searchSummary = "";
  try {
    searchSummary = await fetchWebSearchSummary(searchQuery);
  } catch (error) {
    console.warn("[chat] search route failed:", error);
    return { type: "none" };
  }
  if (searchSummary.startsWith("搜索服务暂时不可用")) {
    return {
      type: "direct",
      tool: "search",
      text: searchSummary,
    };
  }

  return {
    type: "context",
    tool: "search",
    contextText: [
      "工具结果（网页搜索）：",
      searchSummary,
      "请优先基于这些结果回答；如果信息不足，请明确说不确定。",
    ].join("\n"),
    fallbackText: `我先查到这些：\n${searchSummary}`,
  };
}
