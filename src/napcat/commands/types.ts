import type { NapcatClient } from "../client";
import type { MessageSegment } from "../message";

export type CommandAccess = "root" | "user";

type OneBotEventBase = Record<string, unknown> & {
  post_type?: string;
  message_type?: string;
  notice_type?: string;
  request_type?: string;
  meta_event_type?: string;
  sub_type?: string;
  flag?: string;
  self_id?: number;
  user_id?: number;
  group_id?: number;
  message_id?: number | string;
  time?: number;
  raw_message?: string;
  message?: string | MessageSegment[];
};

export type MessageEvent = OneBotEventBase & {
  post_type: "message";
  message_type?: "private" | "group" | string;
  message?: string | MessageSegment[];
};

export type NoticeEvent = OneBotEventBase & {
  post_type: "notice";
  notice_type?: string;
};

export type RequestEvent = OneBotEventBase & {
  post_type: "request";
  request_type?: string;
};

export type MetaEvent = OneBotEventBase & {
  post_type: "meta_event";
  meta_event_type?: string;
};

export type OneBotEvent =
  | MessageEvent
  | NoticeEvent
  | RequestEvent
  | MetaEvent
  | OneBotEventBase;

export function isMessageEvent(event: OneBotEvent): event is MessageEvent {
  return event.post_type === "message";
}

export function isNoticeEvent(event: OneBotEvent): event is NoticeEvent {
  return event.post_type === "notice";
}

export function isRequestEvent(event: OneBotEvent): event is RequestEvent {
  return event.post_type === "request";
}

export function isMetaEvent(event: OneBotEvent): event is MetaEvent {
  return event.post_type === "meta_event";
}

export type CommandExecutionContext = {
  client: NapcatClient;
  event: MessageEvent;
  userId: number;
  groupId?: number;
  messageType?: string;
  isRoot: boolean;
  sendText: (text: string) => Promise<void>;
};

export type CommandDefinition<Payload = unknown> = {
  name: string;
  access?: CommandAccess;
  help?: string;
  cooldownExempt?: boolean;
  allowWhenGroupDisabled?: boolean;
  parse: (message: string) => Payload | null;
  execute: (context: CommandExecutionContext, payload: Payload) => Promise<void>;
};

export type ParsedCommand = {
  definition: CommandDefinition<unknown>;
  payload: unknown;
};

export type CommandMiddlewareContext = CommandExecutionContext & {
  command: ParsedCommand;
};

export type CommandMiddleware = (
  context: CommandMiddlewareContext,
  next: () => Promise<void>,
) => Promise<void>;
