import { config } from "../config";
import type { NapcatClient } from "../napcat/client";
import { configStore } from "../storage/config_store";
import { buildProactiveText, decideProactiveActions, type ProactiveCandidate } from "./proactive";
import { createSessionKey } from "./session_store";
import { chatStateEngine } from "./state_engine";
import type { ChatEvent, TriggerDecision } from "./types";
import type { ChatOrchestrator } from "./orchestrator";

export type ChatAgentLoopRuntimeSnapshot = {
  queueSize: number;
  sessionCount: number;
  pendingProactiveGroups: number;
  pumping: boolean;
  activeReplySessions: number;
  pendingReplySessions: number;
};

export type ChatAgentLoopEvent =
  | {
      type: "incoming";
      sessionKey: string;
      scope: ChatEvent["scope"];
      userId: number;
    }
  | {
      type: "decision";
      sessionKey: string;
      shouldReply: boolean;
      reason: TriggerDecision["reason"];
      priority: TriggerDecision["priority"];
      waitMs: number;
      willingness: number;
    }
  | {
      type: "turn_waiting";
      sessionKey: string;
      seq: number;
      waitMs: number;
      queuedAt: number;
    }
  | {
      type: "turn_enqueued";
      sessionKey: string;
      seq: number;
      queuedAt: number;
    }
  | {
      type: "turn_followup_replaced";
      sessionKey: string;
      previousSeq: number;
      nextSeq: number;
    }
  | {
      type: "turn_started";
      sessionKey: string;
      seq: number;
      queuedDelayMs: number;
    }
  | {
      type: "turn_dropped";
      sessionKey: string;
      seq: number;
      reason: "stale" | "filtered";
    }
  | {
      type: "turn_sent";
      sessionKey: string;
      seq: number;
      from: "llm" | "fallback" | "tool";
      length: number;
    }
  | {
      type: "turn_failed";
      sessionKey: string;
      seq: number;
      error: string;
    }
  | {
      type: "turn_completed";
      sessionKey: string;
      seq: number;
      hadFollowUp: boolean;
    }
  | {
      type: "proactive_enqueued";
      groupId: number;
      reason: ProactiveCandidate["reason"];
      topic: string;
    }
  | {
      type: "proactive_sent";
      groupId: number;
      reason: ProactiveCandidate["reason"];
      topic: string;
    }
  | {
      type: "proactive_skipped";
      groupId: number;
      reason: "group_disabled" | "busy_group";
      topic: string;
    }
  | {
      type: "proactive_failed";
      groupId: number;
      reason: ProactiveCandidate["reason"];
      topic: string;
      error: string;
    }
  | {
      type: "queue_idle";
    };

export type ChatAgentLoopObservedEvent = ChatAgentLoopEvent & {
  eventId: number;
  ts: number;
  runtime: ChatAgentLoopRuntimeSnapshot;
};

type ReplyTurn = {
  seq: number;
  queuedAt: number;
  client: NapcatClient;
  event: ChatEvent;
  decision: TriggerDecision;
};

type ProactiveTurn = {
  now: number;
  client: NapcatClient;
  groupId: number;
  reason: ProactiveCandidate["reason"];
  topic: string;
  text: string;
};

type QueueTurn =
  | {
      kind: "reply";
      sessionKey: string;
      turn: ReplyTurn;
    }
  | {
      kind: "proactive";
      turn: ProactiveTurn;
    };

type SessionLoopState = {
  nextSeq: number;
  minDeliverSeq: number;
  pendingTimer?: NodeJS.Timeout;
  pendingTurn?: ReplyTurn;
  queuedSeq?: number;
  runningSeq?: number;
  followUpTurn?: ReplyTurn;
};

function shouldDelayReply(decision: TriggerDecision): boolean {
  return decision.priority !== "must" && decision.waitMs > 0;
}

function hasBusySession(state: SessionLoopState): boolean {
  return (
    state.pendingTurn !== undefined ||
    state.queuedSeq !== undefined ||
    state.runningSeq !== undefined ||
    state.followUpTurn !== undefined
  );
}

export class ChatAgentLoop {
  private readonly sessions = new Map<string, SessionLoopState>();
  private readonly queue: QueueTurn[] = [];
  private readonly pendingProactiveGroups = new Set<number>();
  private readonly listeners = new Set<(event: ChatAgentLoopObservedEvent) => void>();
  private eventId = 0;
  private pumping = false;

  constructor(private readonly orchestrator: ChatOrchestrator) {}

  subscribe(listener: (event: ChatAgentLoopObservedEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getRuntimeSnapshot(): ChatAgentLoopRuntimeSnapshot {
    let activeReplySessions = 0;
    let pendingReplySessions = 0;
    for (const state of this.sessions.values()) {
      if (state.runningSeq !== undefined || state.queuedSeq !== undefined) {
        activeReplySessions += 1;
      }
      if (state.pendingTurn !== undefined || state.followUpTurn !== undefined) {
        pendingReplySessions += 1;
      }
    }

    return {
      queueSize: this.queue.length,
      sessionCount: this.sessions.size,
      pendingProactiveGroups: this.pendingProactiveGroups.size,
      pumping: this.pumping,
      activeReplySessions,
      pendingReplySessions,
    };
  }

  async onIncomingMessage(client: NapcatClient, event: ChatEvent): Promise<void> {
    chatStateEngine.recordIncoming(event);
    const decision = this.orchestrator.decide(event);
    const sessionKey = createSessionKey(event);
    this.emit({
      type: "incoming",
      sessionKey,
      scope: event.scope,
      userId: event.userId,
    });
    this.emit({
      type: "decision",
      sessionKey,
      shouldReply: decision.shouldReply,
      reason: decision.reason,
      priority: decision.priority,
      waitMs: decision.waitMs,
      willingness: decision.willingness,
    });
    if (!decision.shouldReply) {
      return;
    }

    const session = this.ensureSession(sessionKey);
    const seq = session.nextSeq + 1;
    session.nextSeq = seq;
    const turn: ReplyTurn = {
      seq,
      queuedAt: Date.now(),
      client,
      event,
      decision,
    };

    if (hasBusySession(session)) {
      session.minDeliverSeq = Math.max(session.minDeliverSeq, turn.seq);
    }

    const previousPendingSeq = session.pendingTurn?.seq;
    const previousFollowUpSeq = session.followUpTurn?.seq;
    this.clearPendingTurn(session);

    if (session.runningSeq !== undefined || session.queuedSeq !== undefined) {
      if (previousFollowUpSeq !== undefined && previousFollowUpSeq !== turn.seq) {
        this.emit({
          type: "turn_followup_replaced",
          sessionKey,
          previousSeq: previousFollowUpSeq,
          nextSeq: turn.seq,
        });
      } else if (previousPendingSeq !== undefined && previousPendingSeq !== turn.seq) {
        this.emit({
          type: "turn_followup_replaced",
          sessionKey,
          previousSeq: previousPendingSeq,
          nextSeq: turn.seq,
        });
      }
      session.followUpTurn = turn;
      return;
    }

    this.scheduleTurn(sessionKey, session, turn);
  }

  async runSchedulerTick(client: NapcatClient, now = Date.now()): Promise<void> {
    if (!config.chat.proactiveEnabled) return;

    const snapshots = chatStateEngine.listGroupSnapshots(now);
    if (snapshots.length <= 0) return;

    const enabledGroups = new Set<number>();
    for (const snapshot of snapshots) {
      if (configStore.isGroupEnabled(snapshot.groupId)) {
        enabledGroups.add(snapshot.groupId);
      }
    }
    if (enabledGroups.size <= 0) return;

    const candidates = decideProactiveActions({
      snapshots,
      now,
      enabledGroups,
      idleMs: config.chat.proactiveIdleMs,
      continueIdleMs: config.chat.proactiveContinueIdleMs,
      minGapMs: config.chat.proactiveMinGapMs,
      bubbleIntervalMs: config.chat.proactiveBubbleIntervalMs,
      minRecentMessages: config.chat.proactiveMinRecentMessages,
      maxPerTick: config.chat.proactiveMaxPerTick,
    });
    if (candidates.length <= 0) return;

    for (const candidate of candidates) {
      this.enqueueProactiveTurn(client, candidate, now);
    }
  }

  private ensureSession(sessionKey: string): SessionLoopState {
    const existing = this.sessions.get(sessionKey);
    if (existing) {
      return existing;
    }

    const created: SessionLoopState = {
      nextSeq: 0,
      minDeliverSeq: 0,
    };
    this.sessions.set(sessionKey, created);
    return created;
  }

  private clearPendingTurn(session: SessionLoopState): void {
    if (session.pendingTimer) {
      clearTimeout(session.pendingTimer);
      session.pendingTimer = undefined;
    }
    session.pendingTurn = undefined;
  }

  private scheduleTurn(sessionKey: string, session: SessionLoopState, turn: ReplyTurn): void {
    if (shouldDelayReply(turn.decision)) {
      const waitMs = Math.max(0, Math.floor(turn.decision.waitMs));
      session.pendingTurn = turn;
      this.emit({
        type: "turn_waiting",
        sessionKey,
        seq: turn.seq,
        waitMs,
        queuedAt: turn.queuedAt,
      });
      session.pendingTimer = setTimeout(() => {
        const current = this.sessions.get(sessionKey);
        if (!current || current.pendingTurn?.seq !== turn.seq) {
          return;
        }
        current.pendingTurn = undefined;
        current.pendingTimer = undefined;
        this.enqueueReplyTurn(sessionKey, current, turn);
      }, waitMs);
      return;
    }

    this.enqueueReplyTurn(sessionKey, session, turn);
  }

  private enqueueReplyTurn(sessionKey: string, session: SessionLoopState, turn: ReplyTurn): void {
    session.queuedSeq = turn.seq;
    this.queue.push({
      kind: "reply",
      sessionKey,
      turn,
    });
    this.emit({
      type: "turn_enqueued",
      sessionKey,
      seq: turn.seq,
      queuedAt: turn.queuedAt,
    });
    void this.pumpQueue();
  }

  private enqueueProactiveTurn(
    client: NapcatClient,
    candidate: ProactiveCandidate,
    now: number,
  ): void {
    if (this.pendingProactiveGroups.has(candidate.groupId)) {
      return;
    }
    if (this.hasBusyGroupConversations(candidate.groupId)) {
      return;
    }

    const text = buildProactiveText(candidate, now);
    if (!text) {
      return;
    }

    this.pendingProactiveGroups.add(candidate.groupId);
    this.queue.push({
      kind: "proactive",
      turn: {
        now,
        client,
        groupId: candidate.groupId,
        reason: candidate.reason,
        topic: candidate.topic,
        text,
      },
    });
    this.emit({
      type: "proactive_enqueued",
      groupId: candidate.groupId,
      reason: candidate.reason,
      topic: candidate.topic,
    });
    void this.pumpQueue();
  }

  private async pumpQueue(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;

    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift();
        if (!item) continue;

        if (item.kind === "reply") {
          await this.executeReplyTurn(item.sessionKey, item.turn);
          continue;
        }

        await this.executeProactiveTurn(item.turn);
      }
    } finally {
      this.pumping = false;
      if (this.queue.length <= 0) {
        this.emit({ type: "queue_idle" });
      }
    }
  }

  private async executeReplyTurn(sessionKey: string, turn: ReplyTurn): Promise<void> {
    const session = this.ensureSession(sessionKey);
    if (session.queuedSeq === turn.seq) {
      session.queuedSeq = undefined;
    }

    if (turn.seq < session.minDeliverSeq) {
      this.emit({
        type: "turn_dropped",
        sessionKey,
        seq: turn.seq,
        reason: "stale",
      });
      this.afterReplyTurn(sessionKey, session, turn.seq);
      return;
    }

    session.runningSeq = turn.seq;
    this.emit({
      type: "turn_started",
      sessionKey,
      seq: turn.seq,
      queuedDelayMs: Math.max(0, Date.now() - turn.queuedAt),
    });

    try {
      const prepared = await this.orchestrator.prepare(turn.event, turn.decision);
      if (!prepared) {
        this.emit({
          type: "turn_dropped",
          sessionKey,
          seq: turn.seq,
          reason: "filtered",
        });
        return;
      }

      if (turn.seq < session.minDeliverSeq) {
        this.emit({
          type: "turn_dropped",
          sessionKey,
          seq: turn.seq,
          reason: "stale",
        });
        return;
      }

      await this.sendReply(turn.client, turn.event, prepared.reply.text);
      this.orchestrator.commit(prepared);
      this.emit({
        type: "turn_sent",
        sessionKey,
        seq: turn.seq,
        from: prepared.reply.from,
        length: prepared.reply.text.length,
      });
    } catch (error) {
      const normalizedError = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "turn_failed",
        sessionKey,
        seq: turn.seq,
        error: normalizedError,
      });
      console.warn("[chat] agent_loop reply failed:", error);
    } finally {
      session.runningSeq = undefined;
      this.afterReplyTurn(sessionKey, session, turn.seq);
    }
  }

  private afterReplyTurn(sessionKey: string, session: SessionLoopState, completedSeq: number): void {
    const followUp = session.followUpTurn;
    session.followUpTurn = undefined;
    this.emit({
      type: "turn_completed",
      sessionKey,
      seq: completedSeq,
      hadFollowUp: Boolean(followUp),
    });
    if (followUp) {
      this.scheduleTurn(sessionKey, session, followUp);
      return;
    }

    if (!hasBusySession(session)) {
      this.sessions.delete(sessionKey);
    }
  }

  private async sendReply(client: NapcatClient, event: ChatEvent, text: string): Promise<void> {
    if (event.scope === "group" && typeof event.groupId === "number") {
      await client.sendGroupText(event.groupId, text);
      return;
    }
    await client.sendPrivateText(event.userId, text);
  }

  private hasBusyGroupConversations(groupId: number): boolean {
    const keyPrefix = `g:${groupId}:`;
    for (const [sessionKey, state] of this.sessions.entries()) {
      if (!sessionKey.startsWith(keyPrefix)) continue;
      if (hasBusySession(state)) {
        return true;
      }
    }
    return false;
  }

  private async executeProactiveTurn(turn: ProactiveTurn): Promise<void> {
    try {
      if (!configStore.isGroupEnabled(turn.groupId)) {
        this.emit({
          type: "proactive_skipped",
          groupId: turn.groupId,
          reason: "group_disabled",
          topic: turn.topic,
        });
        return;
      }
      if (this.hasBusyGroupConversations(turn.groupId)) {
        this.emit({
          type: "proactive_skipped",
          groupId: turn.groupId,
          reason: "busy_group",
          topic: turn.topic,
        });
        return;
      }
      await turn.client.sendGroupText(turn.groupId, turn.text);
      chatStateEngine.markProactiveSent(turn.groupId, turn.now);
      this.emit({
        type: "proactive_sent",
        groupId: turn.groupId,
        reason: turn.reason,
        topic: turn.topic,
      });
      console.info(
        `[chat] proactive_sent group=${turn.groupId} reason=${turn.reason} topic=${turn.topic}`,
      );
    } catch (error) {
      const normalizedError = error instanceof Error ? error.message : String(error);
      this.emit({
        type: "proactive_failed",
        groupId: turn.groupId,
        reason: turn.reason,
        topic: turn.topic,
        error: normalizedError,
      });
      console.warn(`[chat] proactive failed group=${turn.groupId}`, error);
    } finally {
      this.pendingProactiveGroups.delete(turn.groupId);
    }
  }

  private emit(event: ChatAgentLoopEvent): void {
    if (this.listeners.size <= 0) {
      return;
    }
    const observed: ChatAgentLoopObservedEvent = {
      ...event,
      eventId: ++this.eventId,
      ts: Date.now(),
      runtime: this.getRuntimeSnapshot(),
    };
    for (const listener of this.listeners) {
      try {
        listener(observed);
      } catch (error) {
        console.warn("[chat] loop event listener failed:", error);
      }
    }
  }
}

export function createChatAgentLoop(orchestrator: ChatOrchestrator): ChatAgentLoop {
  return new ChatAgentLoop(orchestrator);
}
