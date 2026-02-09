import type { MessageSegment } from "../napcat/message";

export type ChatScope = "group" | "private";

export type ChatEvent = {
  scope: ChatScope;
  userId: number;
  selfId?: number;
  groupId?: number;
  messageId?: number | string;
  text: string;
  rawMessage?: string;
  segments?: MessageSegment[];
};

export type TriggerReason =
  | "private_default"
  | "mentioned"
  | "replied_to_bot"
  | "named_bot"
  | "group_disabled"
  | "empty_text"
  | "not_triggered";

export type TriggerDecision = {
  shouldReply: boolean;
  reason: TriggerReason;
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
  from: "llm" | "fallback";
  reason?: TriggerReason;
};
