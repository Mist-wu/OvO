import type { ChatEvent, SessionMessage } from "./types";

export interface SessionStore {
  get(sessionKey: string): SessionMessage[];
  append(sessionKey: string, message: SessionMessage): void;
  clear(sessionKey: string): void;
}

export function createSessionKey(event: ChatEvent): string {
  if (event.scope === "group" && typeof event.groupId === "number") {
    return `g:${event.groupId}:u:${event.userId}`;
  }
  return `p:${event.userId}`;
}

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionMessage[]>();

  constructor(private readonly maxMessages: number) {}

  get(sessionKey: string): SessionMessage[] {
    const current = this.sessions.get(sessionKey);
    if (!current) return [];
    return current.slice();
  }

  append(sessionKey: string, message: SessionMessage): void {
    const current = this.sessions.get(sessionKey) ?? [];
    const next = [...current, message];
    if (next.length > this.maxMessages) {
      this.sessions.set(sessionKey, next.slice(next.length - this.maxMessages));
      return;
    }
    this.sessions.set(sessionKey, next);
  }

  clear(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}
