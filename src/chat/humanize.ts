import { config } from "../config";
import { clamp01 } from "../utils/helpers";

export type HumanizeReplyOptions = {
  seed?: string;
};

function stableRatio(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function normalizePunctuation(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[。]{2,}/g, "。")
    .replace(/[!！]{2,}/g, "！")
    .replace(/[?？]{2,}/g, "？")
    .replace(/[~～]{3,}/g, "~~");
}

function stripAiMeta(text: string): string {
  return text
    .replace(/^(?:作为(?:一个)?AI(?:助手)?|作为模型|我是(?:一个)?AI)[^\n]*\n?/im, "")
    .replace(/(?:以上仅供参考|希望这能帮到你)[\s。！!]*$/im, "")
    .trim();
}

function splitLongSentence(text: string, seed: string): string {
  if (text.length < 52 || text.includes("\n")) return text;
  const punctuations = ["，", "。", "；", ",", ".", ";"];
  const mid = Math.floor(text.length / 2);
  let best = -1;
  for (let offset = 0; offset <= 18; offset += 1) {
    const right = mid + offset;
    const left = mid - offset;
    if (right < text.length && punctuations.includes(text[right])) {
      best = right;
      break;
    }
    if (left >= 0 && punctuations.includes(text[left])) {
      best = left;
      break;
    }
  }
  if (best <= 0) {
    const ratio = stableRatio(`${seed}:split:fallback`);
    const fallbackIndex = Math.max(14, Math.min(text.length - 8, Math.floor(text.length * (0.35 + ratio * 0.2))));
    return `${text.slice(0, fallbackIndex).trim()}\n${text.slice(fallbackIndex).trim()}`;
  }
  return `${text.slice(0, best + 1).trim()}\n${text.slice(best + 1).trim()}`;
}

function applyMinorTypo(text: string, seed: string): string {
  if (text.length < 6) return text;
  if (/[`{}[\]<>_=\\/]/.test(text)) return text;

  const candidates: Array<{ from: string; to: string }> = [
    { from: "的", to: "地" },
    { from: "得", to: "的" },
    { from: "再", to: "在" },
    { from: "在", to: "再" },
    { from: "吗", to: "嘛" },
  ];
  const ranked = candidates.filter((item) => text.includes(item.from));
  if (ranked.length <= 0) return text;
  const index = Math.floor(stableRatio(`${seed}:typo:pick`) * ranked.length);
  const picked = ranked[Math.max(0, Math.min(ranked.length - 1, index))];
  return text.replace(picked.from, picked.to);
}

export function humanizeReply(text: string, options?: HumanizeReplyOptions): string {
  if (!config.chat.humanizeEnabled) {
    return text;
  }

  const seedBase = options?.seed ?? text;
  const splitProb = clamp01(config.chat.humanizeSplitProb);
  const typoProb = clamp01(config.chat.humanizeTypoProb);

  let current = stripAiMeta(text);
  current = normalizePunctuation(current);

  if (stableRatio(`${seedBase}:split`) <= splitProb) {
    current = splitLongSentence(current, seedBase);
  }
  if (stableRatio(`${seedBase}:typo`) <= typoProb) {
    current = applyMinorTypo(current, seedBase);
  }

  return current.trim();
}
