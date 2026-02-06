import type { NapcatClient } from "../client";
import type { MessageSegment } from "../message";

export type OneBotEvent = Record<string, unknown> & {
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
  raw_message?: string;
  message?: string | MessageSegment[];
};

export type CommandExecutionContext = {
  client: NapcatClient;
  event: OneBotEvent;
  userId: number;
  groupId?: number;
  messageType?: string;
  isRoot: boolean;
  sendText: (text: string) => Promise<void>;
};

export type CommandDefinition<Payload = unknown> = {
  name: string;
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
