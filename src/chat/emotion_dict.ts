/**
 * 情感分析词典 —— 将硬编码的正则关键词提取为可维护的结构化配置。
 *
 * 每条规则由一个 pattern (string[]) 和一个 delta (number) 组成。
 * `inferEmotion()` 会依次匹配 text 是否包含任一 pattern 关键词，
 * 若匹配，则将 score 累加 delta。
 *
 * 分离出来的好处：
 *   1. 可随时增删关键词，无需改动推理逻辑
 *   2. 未来可按需从外部 JSON 加载或让 LLM 动态扩充
 */

export type EmotionRule = {
    /** 匹配的关键词列表，任一命中即生效 */
    keywords: string[];
    /** 命中后对情感分值的增量（正 = 积极 / 兴奋，负 = 消极） */
    delta: number;
};

export type EmotionLabel = "positive" | "excited" | "negative" | "curious" | "neutral";

/** 情感规则表 —— 按优先级从上到下匹配 */
export const EMOTION_RULES: EmotionRule[] = [
    {
        keywords: ["开心", "高兴", "喜欢", "赞", "太棒", "牛", "厉害", "哈哈", "笑死", "好耶"],
        delta: 0.5,
    },
    {
        keywords: ["难受", "烦", "气死", "无语", "崩溃", "累", "糟糕", "讨厌", "服了", "离谱"],
        delta: -0.55,
    },
    {
        keywords: ["吗", "呢", "?", "？", "为啥", "为什么", "怎么", "咋"],
        delta: 0.12,
    },
    {
        keywords: ["!", "！"],
        delta: 0.18,
    },
    {
        keywords: ["哇", "卧槽", "逆天", "太强", "炸裂"],
        delta: 0.25,
    },
];

/** 停用词集合 —— 用于话题关键词提取时的过滤 */
export const STOP_WORDS: ReadonlySet<string> = new Set([
    "这个",
    "那个",
    "就是",
    "然后",
    "感觉",
    "你们",
    "我们",
    "他们",
    "今天",
    "明天",
    "现在",
    "一下",
    "一下子",
    "可以",
    "是不是",
    "怎么",
    "为什么",
    "什么",
    "一个",
    "没有",
    "真的",
    "哈哈",
    "hhh",
    "ok",
    "好的",
    "吗",
    "呢",
    "啊",
    "呀",
    "啦",
    "了",
]);

/** 情感标签阈值配置 */
export const EMOTION_THRESHOLDS = {
    positiveMin: 0.42,
    excitedMin: 0.22,
    negativeMax: -0.38,
    curiousMinScore: -0.12,
} as const;
