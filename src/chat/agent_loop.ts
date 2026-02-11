import { config } from "../config";
import type { NapcatClient } from "../napcat/client";
import { configStore } from "../storage/config_store";
import { buildProactiveText, decideProactiveActions, type ProactiveCandidate } from "./proactive";
import { createSessionKey } from "./session_store";
import { chatStateEngine } from "./state_engine";
import type { ChatEvent, TriggerDecision } from "./types";
import type { ChatOrchestrator } from "./orchestrator";

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
  private pumping = false;

  constructor(private readonly orchestrator: ChatOrchestrator) {}

  async onIncomingMessage(client: NapcatClient, event: ChatEvent): Promise<void> {
    chatStateEngine.recordIncoming(event);

    const decision = this.orchestrator.decide(event);
    if (!decision.shouldReply) {
      return;
    }

    const sessionKey = createSessionKey(event);
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

    this.clearPendingTurn(session);

    if (session.runningSeq !== undefined || session.queuedSeq !== undefined) {
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
    }
  }

  private async executeReplyTurn(sessionKey: string, turn: ReplyTurn): Promise<void> {
    const session = this.ensureSession(sessionKey);
    if (session.queuedSeq === turn.seq) {
      session.queuedSeq = undefined;
    }

    if (turn.seq < session.minDeliverSeq) {
      this.afterReplyTurn(sessionKey, session);
      return;
    }

    session.runningSeq = turn.seq;

    try {
      const prepared = await this.orchestrator.prepare(turn.event, turn.decision);
      if (!prepared) {
        return;
      }

      if (turn.seq < session.minDeliverSeq) {
        return;
      }

      await this.sendReply(turn.client, turn.event, prepared.reply.text);
      this.orchestrator.commit(prepared);
    } catch (error) {
      console.warn("[chat] agent_loop reply failed:", error);
    } finally {
      session.runningSeq = undefined;
      this.afterReplyTurn(sessionKey, session);
    }
  }

  private afterReplyTurn(sessionKey: string, session: SessionLoopState): void {
    const followUp = session.followUpTurn;
    session.followUpTurn = undefined;
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
        return;
      }
      if (this.hasBusyGroupConversations(turn.groupId)) {
        return;
      }
      await turn.client.sendGroupText(turn.groupId, turn.text);
      chatStateEngine.markProactiveSent(turn.groupId, turn.now);
      console.info(
        `[chat] proactive_sent group=${turn.groupId} reason=${turn.reason} topic=${turn.topic}`,
      );
    } catch (error) {
      console.warn(`[chat] proactive failed group=${turn.groupId}`, error);
    } finally {
      this.pendingProactiveGroups.delete(turn.groupId);
    }
  }
}

export function createChatAgentLoop(orchestrator: ChatOrchestrator): ChatAgentLoop {
  return new ChatAgentLoop(orchestrator);
}
