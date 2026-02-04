import type { NapcatClient } from "./client";

type OneBotEvent = Record<string, unknown> & {
  post_type?: string;
  message_type?: string;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
};

export async function handleEvent(client: NapcatClient, event: OneBotEvent): Promise<void> {
  if (event.post_type !== "message") {
    return;
  }

  const message = typeof event.raw_message === "string" ? event.raw_message.trim() : "";
  if (!message) {
    return;
  }

  if (message === "/ping") {
    if (event.message_type === "private" && typeof event.user_id === "number") {
      await client.sendPrivateText(event.user_id, "pong");
      return;
    }
    if (event.message_type === "group" && typeof event.group_id === "number") {
      await client.sendGroupText(event.group_id, "pong");
    }
  }
}
