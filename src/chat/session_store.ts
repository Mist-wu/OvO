import type { ChatEvent, SessionMessage } from "./types";

export interface SessionStore {
  get(sessionKey: string): SessionMessage[];
  append(sessionKey: string, message: SessionMessage): void;
  replace(sessionKey: string, messages: SessionMessage[]): void;
  takeOldest(sessionKey: string, count: number): SessionMessage[];
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

  replace(sessionKey: string, messages: SessionMessage[]): void {
    if (messages.length <= 0) {
      this.sessions.delete(sessionKey);
      return;
    }

    if (messages.length > this.maxMessages) {
      this.sessions.set(sessionKey, messages.slice(messages.length - this.maxMessages));
      return;
    }

    this.sessions.set(sessionKey, messages.slice());
  }

  takeOldest(sessionKey: string, count: number): SessionMessage[] {
    const current = this.sessions.get(sessionKey);
    if (!current || current.length <= 0) return [];

    const normalizedCount = Math.max(0, Math.floor(count));
    if (normalizedCount <= 0) return [];

    const taken = current.slice(0, normalizedCount);
    const rest = current.slice(taken.length);
    if (rest.length <= 0) {
      this.sessions.delete(sessionKey);
    } else {
      this.sessions.set(sessionKey, rest);
    }
    return taken;
  }

  clear(sessionKey: string): void {
    this.sessions.delete(sessionKey);
  }
}
