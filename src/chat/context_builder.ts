import { buildPersonaPrompt } from "./persona";
import type { PersonaProfile, SessionMessage } from "./types";

export type BuildContextInput = {
  persona: PersonaProfile;
  history: SessionMessage[];
  userText: string;
  scope: "group" | "private";
};

function formatHistory(history: SessionMessage[]): string {
  if (history.length === 0) return "(无历史)";
  return history
    .map((item) => `${item.role === "user" ? "用户" : "小o"}: ${item.text}`)
    .join("\n");
}

export function buildPrompt(input: BuildContextInput): string {
  const scene = input.scope === "group" ? "群聊" : "私聊";
  const personaPrompt = buildPersonaPrompt(input.persona);
  const historyText = formatHistory(input.history);

  return [
    personaPrompt,
    `场景：${scene}`,
    "以下是最近会话（按时间顺序）：",
    historyText,
    `用户当前消息：${input.userText}`,
    "请直接输出回复正文，不要附加解释。",
  ].join("\n\n");
}
