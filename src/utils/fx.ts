import { config } from "../config";
import { ExternalCallError, runExternalCall } from "./external_call";

export type FxQueryIntent = {
  amount: number;
  from: string;
  to: string;
};

type FxApiPayload = {
  result?: string;
  base_code?: string;
  rates?: Record<string, number>;
  time_last_update_utc?: string;
};

const CURRENCY_ALIAS: Record<string, string> = {
  人民币: "CNY",
  rmb: "CNY",
  cny: "CNY",
  美元: "USD",
  美金: "USD",
  usd: "USD",
  欧元: "EUR",
  eur: "EUR",
  日元: "JPY",
  jpy: "JPY",
  英镑: "GBP",
  gbp: "GBP",
  港币: "HKD",
  hkd: "HKD",
  韩元: "KRW",
  krw: "KRW",
  新加坡元: "SGD",
  sgd: "SGD",
  澳元: "AUD",
  aud: "AUD",
  加元: "CAD",
  cad: "CAD",
};

function normalizeCurrency(raw: string): string {
  const key = raw.trim().toLowerCase();
  const mapped = CURRENCY_ALIAS[key];
  if (mapped) return mapped;
  if (/^[a-z]{3}$/i.test(raw.trim())) return raw.trim().toUpperCase();
  return "";
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "NaN";
  return Number(value.toFixed(6)).toString();
}

function formatUpdateTime(raw: string | undefined): string {
  if (!raw) return "未知";
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

export function detectFxIntent(text: string): FxQueryIntent | undefined {
  const normalized = text.trim();
  if (!normalized || normalized.startsWith("/")) return undefined;
  if (!/(汇率|兑|换算|换成|to)/i.test(normalized)) return undefined;

  const strictCode = normalized.match(
    /(\d+(?:\.\d+)?)\s*([a-zA-Z]{3})\s*(?:to|->|兑|换成|转换为)\s*([a-zA-Z]{3})/i,
  );
  if (strictCode) {
    const amount = Number(strictCode[1]);
    const from = normalizeCurrency(strictCode[2]);
    const to = normalizeCurrency(strictCode[3]);
    if (Number.isFinite(amount) && amount > 0 && from && to) {
      return { amount, from, to };
    }
  }

  const zh = normalized.match(
    /(\d+(?:\.\d+)?)\s*([^\s\d]{1,8})\s*(?:兑|换成|换算成|转换为)\s*([^\s\d]{1,8})/,
  );
  if (zh) {
    const amount = Number(zh[1]);
    const from = normalizeCurrency(zh[2]);
    const to = normalizeCurrency(zh[3]);
    if (Number.isFinite(amount) && amount > 0 && from && to) {
      return { amount, from, to };
    }
  }

  const quoteOnly = normalized.match(/([^\s]{1,8})\s*(?:兑|对)?\s*([^\s]{1,8})\s*汇率/);
  if (quoteOnly) {
    const from = normalizeCurrency(quoteOnly[1]);
    const to = normalizeCurrency(quoteOnly[2]);
    if (from && to) {
      return { amount: 1, from, to };
    }
  }

  return undefined;
}

export async function fetchFxSummary(
  intent: FxQueryIntent,
  signal?: AbortSignal,
): Promise<string> {
  const amount = Number(intent.amount);
  const from = normalizeCurrency(intent.from);
  const to = normalizeCurrency(intent.to);
  if (!Number.isFinite(amount) || amount <= 0 || !from || !to) {
    return "汇率查询参数不合法";
  }

  const circuitBreaker = {
    enabled: config.external.circuitBreakerEnabled,
    key: "fx",
    failureThreshold: config.external.circuitFailureThreshold,
    openMs: config.external.circuitOpenMs,
  };

  const payload = await runExternalCall<FxApiPayload | string>(
    {
      service: "fx",
      operation: "exchange_rate",
      timeoutMs: config.fx.timeoutMs,
      signal,
      retries: config.external.fx.retries,
      retryDelayMs: config.external.fx.retryDelayMs,
      concurrency: config.external.fx.concurrency,
      circuitBreaker,
      fallback: (error) => resolveFxFallback(error),
    },
    async ({ signal }) => {
      const url = `https://open.er-api.com/v6/latest/${encodeURIComponent(from)}`;
      const response = await fetch(url, { signal });
      if (!response.ok) {
        throw new Error(`[fx] request failed status=${response.status}`);
      }
      return (await response.json()) as FxApiPayload;
    },
  );

  if (typeof payload === "string") {
    return payload;
  }

  const rate = payload.rates?.[to];
  if (typeof rate !== "number" || !Number.isFinite(rate)) {
    return `汇率查询失败：未找到 ${from}->${to} 汇率`;
  }

  const converted = amount * rate;
  return [
    `汇率换算：${formatNumber(amount)} ${from} ≈ ${formatNumber(converted)} ${to}`,
    `参考汇率：1 ${from} = ${formatNumber(rate)} ${to}`,
    `更新时间：${formatUpdateTime(payload.time_last_update_utc)}`,
  ].join("\n");
}

function resolveFxFallback(error: ExternalCallError): string {
  const cause = error.cause;
  if (cause instanceof Error && cause.name === "AbortError") {
    throw cause;
  }
  if (!config.external.fx.degradeOnFailure) {
    throw error;
  }
  if (error.reason === "circuit_open" || error.retryable) {
    return "汇率服务暂时不可用，请稍后重试";
  }
  throw error;
}
