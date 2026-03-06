import type { MessageSegment } from "../napcat/message";

type ChatScope = "group" | "private";

export type ChatQuotedMessage = {
  messageId: number | string;
  text: string;
  senderName?: string;
  rawMessage?: string;
  userId?: number | string;
  segments?: MessageSegment[];
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

type TriggerReason =
  | "private_default"
  | "mentioned"
  | "empty_text"
  | "not_triggered";

type ReplyPriority = "must" | "high" | "normal" | "low";

export type TriggerDecision = {
  shouldReply: boolean;
  reason: TriggerReason;
  priority: ReplyPriority;
  willingness: number;
};

export type ChatReply = {
  text: string;
  from: "llm" | "fallback" | "tool";
  reason?: TriggerReason;
  priority?: ReplyPriority;
  willingness?: number;
  quoteMessageId?: number | string;
};
