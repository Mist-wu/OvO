import { chatPromptManager, type PromptTemplateVars } from "./prompt_system";

const CHAT_REPLY_PROMPT_TEMPLATE = "maibot_replyer_prompt";

chatPromptManager.register(
  CHAT_REPLY_PROMPT_TEMPLATE,
  [
    "{knowledge_prompt}{tool_info_block}{extra_info_block}",
    "",
    "{identity_block}",
    "",
    "你正在{scene_label}里聊天，下面是聊天上下文（包含最近对话、状态信息和补充信息）。",
    "{dialogue_intro}",
    "{dialogue_prompt}",
    "",
    "{quoted_message_block}",
    "用户当前消息：{user_message}",
    "",
    "动作规划提示：",
    "{planner_reasoning}",
    "",
    "请先把握当前话题和对方真实诉求，再给出自然、口语化、简洁的回复。",
    "{reply_style}",
    "请注意不要输出多余内容（包括解释、前后缀、角色说明、at/@等），只输出发言内容。",
    "如果信息不充分，先简短追问，不要编造事实。",
    "请直接输出回复正文，不要附加解释。",
  ].join("\n"),
);

export function formatMaiBotReplyPrompt(vars: PromptTemplateVars): string {
  return chatPromptManager.format(CHAT_REPLY_PROMPT_TEMPLATE, vars);
}

