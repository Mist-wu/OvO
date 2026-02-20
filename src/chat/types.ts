import type { MessageSegment } from "../napcat/message";

export type ChatScope = "group" | "private";

export type ChatQuotedMessage = {
  messageId: number | string;
  text: string;
  senderName?: string;
  rawMessage?: string;
  userId?: number | string;
};

export type ChatEvent = {
  scope: ChatScope;
  userId: number;
  senderName?: string;
  selfId?: number;
  groupId?: number;
  messageId?: number | string;
  eventTimeMs?: number;
  text: string;
  rawMessage?: string;
  segments?: MessageSegment[];
  quotedMessage?: ChatQuotedMessage;
};

export type ChatVisualInput = {
  source: string;
  mimeType: string;
  dataBase64: string;
};

export type TriggerReason =
  | "private_default"
  | "mentioned"
  | "replied_to_bot"
  | "named_bot"
  | "group_willing"
  | "group_disabled"
  | "empty_text"
  | "not_triggered";

export type ReplyPriority = "must" | "high" | "normal" | "low";

export type TriggerDecision = {
  shouldReply: boolean;
  reason: TriggerReason;
  priority: ReplyPriority;
  waitMs: number;
  willingness: number;
};

export type SessionRole = "user" | "assistant";

export type SessionMessage = {
  role: SessionRole;
  text: string;
  ts: number;
};

export type PersonaProfile = {
  name: string;
  style: string;
  slang: string[];
  doNot: string[];
  replyLength: "short" | "medium";
};

export type ChatReply = {
  text: string;
  from: "llm" | "fallback" | "tool";
  reason?: TriggerReason;
  priority?: ReplyPriority;
  willingness?: number;
  quoteMessageId?: number | string;
  plannerReason?: string;
  styleVariant?: "default" | "warm" | "playful" | "concise";
};
