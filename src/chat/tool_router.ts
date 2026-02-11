import { detectFxIntent } from "../utils/fx";
import { detectTimeIntent } from "../utils/time";
import { runtimeSkills } from "../skills/runtime";
import type { ChatEvent } from "./types";

export type ToolRouteResult =
  | { type: "none" }
  | {
      type: "direct";
      tool: "weather" | "search" | "time" | "fx" | "calc";
      skillName: string;
      text: string;
    }
  | {
      type: "context";
      tool: "search";
      skillName: string;
      contextText: string;
      fallbackText: string;
    };

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

export function detectMathExpression(text: string): string | undefined {
  const normalized = normalizeText(text);
  if (!normalized || normalized.startsWith("/")) return undefined;
  if (!/(计算|算一下|等于|求值|表达式|[\d)\]]\s*[+\-*/×xX÷]\s*[\d(\[])/.test(normalized)) {
    return undefined;
  }
  const matched = normalized.match(/([()\d+\-*/×xX÷.\s]{3,120})/);
  if (!matched) return undefined;
  return matched[1].trim();
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

export async function routeChatTool(
  event: ChatEvent,
  signal?: AbortSignal,
): Promise<ToolRouteResult> {
  const userText = normalizeText(event.text);
  if (!userText) return { type: "none" };

  const weatherLocation = detectWeatherLocation(userText);
  if (weatherLocation) {
    const result = await runtimeSkills.executor.execute({
      capability: "weather",
      location: weatherLocation,
      query: userText,
    }, { signal });
    if (result.handled) {
      return {
        type: "direct",
        tool: "weather",
        skillName: result.skillName,
        text: result.text,
      };
    }
    return { type: "none" };
  }

  const timeIntent = detectTimeIntent(userText);
  if (timeIntent) {
    const result = await runtimeSkills.executor.execute({
      capability: "time",
      timezone: timeIntent.timezone,
      label: timeIntent.label,
      query: userText,
    }, { signal });
    if (result.handled) {
      return {
        type: "direct",
        tool: "time",
        skillName: result.skillName,
        text: result.text,
      };
    }
  }

  const fxIntent = detectFxIntent(userText);
  if (fxIntent) {
    const result = await runtimeSkills.executor.execute({
      capability: "fx",
      amount: fxIntent.amount,
      from: fxIntent.from,
      to: fxIntent.to,
      query: userText,
    }, { signal });
    if (result.handled) {
      return {
        type: "direct",
        tool: "fx",
        skillName: result.skillName,
        text: result.text,
      };
    }
  }

  const expression = detectMathExpression(userText);
  if (expression) {
    const result = await runtimeSkills.executor.execute({
      capability: "calc",
      expression,
      query: userText,
    }, { signal });
    if (result.handled) {
      return {
        type: "direct",
        tool: "calc",
        skillName: result.skillName,
        text: result.text,
      };
    }
  }

  const searchQuery = detectSearchQuery(userText);
  if (!searchQuery) {
    return { type: "none" };
  }

  const result = await runtimeSkills.executor.execute({
    capability: "search",
    query: searchQuery,
  }, { signal });
  if (!result.handled) {
    return { type: "none" };
  }

  if (result.mode === "direct") {
    return {
      type: "direct",
      tool: "search",
      skillName: result.skillName,
      text: result.text,
    };
  }

  return {
    type: "context",
    tool: "search",
    skillName: result.skillName,
    contextText: result.text,
    fallbackText: result.fallbackText ?? "搜索技能不可用，请稍后重试",
  };
}
