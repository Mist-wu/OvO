// ─── 数值工具 ───

/**
 * 将 value 规范化为正整数，若无效则返回 fallback。
 * 支持 `number | undefined` 和 `number` 两种入参风格。
 */
export function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

/** 将 value 规范化为 ≥0 的整数，若无效则返回 fallback。 */
export function normalizeNonNegativeInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

/** 将 value 限制在 [min, max] 区间内，NaN → min。 */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** clamp 到 [0, 1]。 */
export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

// ─── 文本工具 ───

/** 将连续空白折叠为单个空格并 trim。 */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 截断文本到 maxLength，超出时末尾加 '…'。 */
export function clipText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

// ─── 错误工具 ───

/** 将任意 unknown 包装为 Error。 */
export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

/** 判断一个错误是否为 AbortError（名称匹配或 message 包含 abort）。 */
export function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AbortError") return true;
  return /abort/i.test(error.message);
}
