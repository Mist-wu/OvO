import { randomUUID } from "crypto";
import WebSocket from "ws";

import { config } from "../config";
import { scheduleLoop } from "../utils/schedule_tasks";
import {
  createGetStatusParams,
  createSendGroupMsgParams,
  createSendPrivateMsgParams,
  createSetFriendAddRequestParams,
  createSetGroupAddRequestParams,
  type ActionData,
  type ActionParams,
  type ActionResponse,
  type NapcatActionName,
} from "./actions";
import { handleEvent } from "./handlers";
import type { OneBotEvent } from "./commands/types";
import { normalizeMessage, type MessageInput } from "./message";

type ActionLogLevel = "error" | "warn" | "info" | "debug";

type PendingAction = {
  resolve: (response: ActionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
  startedAt: number;
};

type QueuedAction = {
  action: string;
  params: Record<string, unknown>;
  baseEcho: string;
  resolve: (response: ActionResponse) => void;
  reject: (error: Error) => void;
};

type RuntimeStatus = {
  connected: boolean;
  reconnecting: boolean;
  pendingActions: number;
  queuedActions: number;
  inFlightActions: number;
  lastPongAt: number;
  queueOverflowCount: number;
  retryCount: number;
  rateLimitWaitMsTotal: number;
};

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeNonNegativeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized >= 0 ? normalized : fallback;
}

export function calculateActionRetryDelayMs(
  baseDelayMs: number,
  maxDelayMs: number,
  retryIndex: number,
): number {
  const normalizedRetryIndex = Math.max(0, Math.floor(retryIndex));
  const factor = 2 ** normalizedRetryIndex;
  const delayMs = baseDelayMs * factor;
  return Math.min(delayMs, maxDelayMs);
}

export class NapcatClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private shuttingDown = false;
  private pendingActions = new Map<string, PendingAction>();
  private actionQueue: QueuedAction[] = [];
  private actionInFlight = 0;
  private readonly actionQueueConcurrency = normalizePositiveInt(
    config.napcat.actionQueue.concurrency,
    1,
  );
  private readonly actionQueueMaxSize = normalizePositiveInt(config.napcat.actionQueue.maxSize, 200);
  private readonly actionRateLimitPerSecond = normalizePositiveInt(
    config.napcat.actionQueue.rateLimitPerSecond,
    20,
  );
  private readonly actionRetryAttempts = normalizeNonNegativeInt(
    config.napcat.actionQueue.retryAttempts,
    1,
  );
  private readonly actionRetryBaseDelayMs = normalizePositiveInt(
    config.napcat.actionQueue.retryBaseDelayMs,
    200,
  );
  private readonly actionRetryMaxDelayMs = normalizePositiveInt(
    config.napcat.actionQueue.retryMaxDelayMs,
    1500,
  );
  private actionSendTimestamps: number[] = [];
  private rateLimitLock: Promise<void> = Promise.resolve();
  private queueOverflowCount = 0;
  private retryCount = 0;
  private rateLimitWaitMsTotal = 0;

  connect(): void {
    if (this.shuttingDown) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    const headers: Record<string, string> = {};
    if (config.napcat.token) {
      headers.Authorization = `Bearer ${config.napcat.token}`;
    }

    console.log(`正在连接到 NapCatQQ 服务器: ${config.napcat.url}`);
    const ws = new WebSocket(config.napcat.url, { headers });
    this.ws = ws;

    ws.on("open", async () => {
      console.log("连接成功，开始监听消息");
      this.startHeartbeat();
      this.scheduleTimer = scheduleLoop(this);
      this.pumpActionQueue();

      if (typeof config.permissions.rootUserId === "number") {
        try {
          await this.sendPrivateText(config.permissions.rootUserId, "Bot成功启动");
        } catch (error) {
          console.warn("启动通知发送失败:", error);
        }
      }
    });

    ws.on("message", (data) => {
      void this.onMessage(data);
    });

    ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    ws.on("close", (code, reason) => {
      console.warn(`连接已关闭: ${code} ${reason.toString()}`);
      this.failPendingActions(new Error(`WebSocket closed: ${code} ${reason.toString()}`));
      this.cleanup();
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      console.error("WebSocket 错误:", error);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.failPendingActions(new Error("WebSocket shutdown"));
    this.failQueuedActions(new Error("WebSocket shutdown"));
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
  }

  sendAction<TAction extends NapcatActionName>(
    action: TAction,
    params: ActionParams<TAction>,
    echo?: string,
  ): Promise<ActionResponse<ActionData<TAction>>>;
  sendAction(
    action: string,
    params?: Record<string, unknown>,
    echo?: string,
  ): Promise<ActionResponse>;
  async sendAction(
    action: string,
    params: Record<string, unknown> = {},
    echo: string = randomUUID(),
  ): Promise<ActionResponse> {
    if (!this.isWsOpen()) {
      throw new Error("WebSocket 未连接");
    }
    if (this.actionQueue.length >= this.actionQueueMaxSize) {
      this.queueOverflowCount += 1;
      throw new Error(
        `[action] queue_overflow action=${action} size=${this.actionQueue.length} max=${this.actionQueueMaxSize}`,
      );
    }

    return new Promise<ActionResponse>((resolve, reject) => {
      this.actionQueue.push({
        action,
        params,
        baseEcho: echo,
        resolve,
        reject,
      });
      this.pumpActionQueue();
    });
  }

  sendMessage(options: {
    userId: number;
    groupId?: undefined;
    message: MessageInput;
  }): Promise<ActionResponse<ActionData<"send_private_msg">>>;
  sendMessage(options: {
    userId?: undefined;
    groupId: number;
    message: MessageInput;
  }): Promise<ActionResponse<ActionData<"send_group_msg">>>;
  sendMessage(options: {
    userId?: number;
    groupId?: number;
    message: MessageInput;
  }): Promise<ActionResponse>;
  async sendMessage(options: {
    userId?: number;
    groupId?: number;
    message: MessageInput;
  }): Promise<ActionResponse> {
    const { userId, groupId, message } = options;
    const messageSegments = normalizeMessage(message);

    if (typeof groupId === "number" && typeof userId === "number") {
      throw new Error("sendMessage 只能设置 groupId 或 userId 之一");
    }

    if (typeof groupId === "number") {
      return this.sendAction(
        "send_group_msg",
        createSendGroupMsgParams(groupId, messageSegments),
      );
    }

    if (typeof userId === "number") {
      return this.sendAction(
        "send_private_msg",
        createSendPrivateMsgParams(userId, messageSegments),
      );
    }

    throw new Error("sendMessage 需要 groupId 或 userId");
  }

  sendActionNoWait<TAction extends NapcatActionName>(
    action: TAction,
    params: ActionParams<TAction>,
    echo?: string,
  ): Promise<void>;
  sendActionNoWait(
    action: string,
    params?: Record<string, unknown>,
    echo?: string,
  ): Promise<void>;
  async sendActionNoWait(
    action: string,
    params: Record<string, unknown> = {},
    echo: string = randomUUID(),
  ): Promise<void> {
    await this.reserveRateLimitSlot();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }

    const payload = { action, params, echo };
    await new Promise<void>((resolve, reject) => {
      ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  sendPrivateText(
    userId: number,
    message: string,
  ): Promise<ActionResponse<ActionData<"send_private_msg">>> {
    return this.sendMessage({ userId, message });
  }

  sendGroupText(
    groupId: number,
    message: string,
  ): Promise<ActionResponse<ActionData<"send_group_msg">>> {
    return this.sendMessage({ groupId, message });
  }

  getStatus(): Promise<ActionResponse<ActionData<"get_status">>> {
    return this.sendAction("get_status", createGetStatusParams());
  }

  approveGroupRequest(
    flag: string,
    subType: string | undefined,
  ): Promise<ActionResponse<ActionData<"set_group_add_request">>> {
    return this.sendAction(
      "set_group_add_request",
      createSetGroupAddRequestParams(flag, subType, true),
    );
  }

  approveFriendRequest(flag: string): Promise<ActionResponse<ActionData<"set_friend_add_request">>> {
    return this.sendAction("set_friend_add_request", createSetFriendAddRequestParams(flag, true));
  }

  getRuntimeStatus(): RuntimeStatus {
    return {
      connected: this.isWsOpen(),
      reconnecting: this.reconnectTimer !== null,
      pendingActions: this.pendingActions.size,
      queuedActions: this.actionQueue.length,
      inFlightActions: this.actionInFlight,
      lastPongAt: this.lastPongAt,
      queueOverflowCount: this.queueOverflowCount,
      retryCount: this.retryCount,
      rateLimitWaitMsTotal: this.rateLimitWaitMsTotal,
    };
  }

  private async onMessage(data: WebSocket.RawData): Promise<void> {
    const raw = this.decodeMessage(data);
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      console.warn(`[警告] 无法解析的消息: ${raw}`);
      return;
    }

    if (!event || typeof event !== "object") {
      return;
    }

    if ("post_type" in event) {
      try {
        await handleEvent(this, event as OneBotEvent);
      } catch (error) {
        console.error("事件处理失败:", error);
      }
      return;
    }

    if ("echo" in event || ("status" in event && "retcode" in event)) {
      this.handleActionResponse(event as ActionResponse);
      return;
    }
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, config.napcat.reconnectMs);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    const interval = Math.max(5000, Math.floor(config.napcat.heartbeatTimeoutMs / 2));
    this.lastPongAt = Date.now();

    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (now - this.lastPongAt > config.napcat.heartbeatTimeoutMs) {
        console.warn("心跳超时，准备重连");
        ws.terminate();
        return;
      }

      try {
        ws.ping();
      } catch (error) {
        console.warn("心跳 ping 失败:", error);
      }
    }, interval);
  }

  private cleanup(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private pumpActionQueue(): void {
    if (this.shuttingDown) return;
    if (!this.isWsOpen()) return;

    while (
      this.actionInFlight < this.actionQueueConcurrency &&
      this.actionQueue.length > 0
    ) {
      const queued = this.actionQueue.shift();
      if (!queued) return;

      this.actionInFlight += 1;
      void this.runQueuedAction(queued).finally(() => {
        this.actionInFlight -= 1;
        this.pumpActionQueue();
      });
    }
  }

  private async runQueuedAction(queued: QueuedAction): Promise<void> {
    try {
      const response = await this.executeActionWithRetry(
        queued.action,
        queued.params,
        queued.baseEcho,
      );
      queued.resolve(response);
    } catch (error) {
      queued.reject(this.toError(error));
    }
  }

  private async executeActionWithRetry(
    action: string,
    params: Record<string, unknown>,
    baseEcho: string,
  ): Promise<ActionResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.actionRetryAttempts; attempt += 1) {
      const echo = attempt === 0 ? baseEcho : `${baseEcho}:r${attempt}`;

      try {
        return await this.sendActionOnce(action, params, echo);
      } catch (error) {
        const normalizedError = this.toError(error);
        lastError = normalizedError;

        if (attempt < this.actionRetryAttempts && this.shouldRetryAction(normalizedError)) {
          const delayMs = this.getRetryDelayMs(attempt);
          this.retryCount += 1;
          this.logAction(
            "warn",
            `[action] retry action=${action} next_attempt=${attempt + 2} delay_ms=${delayMs} reason=${normalizedError.message}`,
          );
          await this.delayRetry(delayMs);
          continue;
        }

        throw normalizedError;
      }
    }

    throw lastError ?? new Error(`[action] action=${action} unknown error`);
  }

  private async sendActionOnce(
    action: string,
    params: Record<string, unknown>,
    echo: string,
  ): Promise<ActionResponse> {
    await this.reserveRateLimitSlot();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket 未连接");
    }

    const payload = { action, params, echo };
    return new Promise<ActionResponse>((resolve, reject) => {
      const timeoutMs = Math.max(1000, config.napcat.actionTimeoutMs);
      const timer = setTimeout(() => {
        this.pendingActions.delete(echo);
        this.logAction(
          "warn",
          `[action] timeout action=${action} echo=${echo} cost=${timeoutMs}ms`,
        );
        reject(new Error(`[action] action=${action} timeout=${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingActions.set(echo, {
        resolve,
        reject,
        timer,
        action,
        startedAt: Date.now(),
      });

      ws.send(JSON.stringify(payload), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pendingActions.delete(echo);
          reject(error);
        }
      });
    });
  }

  private handleActionResponse(response: ActionResponse): void {
    const echo = typeof response.echo === "string" ? response.echo : undefined;
    if (!echo) {
      this.logAction("debug", "收到 action 回包(无 echo)", response);
      return;
    }

    const pending = this.pendingActions.get(echo);
    if (!pending) {
      this.logAction("debug", "收到 action 回包(未匹配 echo)", response);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingActions.delete(echo);
    const costMs = Date.now() - pending.startedAt;

    const okStatus = response.status ? response.status === "ok" : true;
    const okRetcode = typeof response.retcode === "number" ? response.retcode === 0 : true;
    if (okStatus && okRetcode) {
      this.logAction(
        "info",
        `[action] ok action=${pending.action} echo=${echo} cost=${costMs}ms`,
      );
      pending.resolve(response);
      return;
    }

    this.logAction(
      "warn",
      `[action] fail action=${pending.action} echo=${echo} cost=${costMs}ms`,
    );
    pending.reject(this.formatActionError(pending.action, response));
  }

  private logAction(level: ActionLogLevel, message: string, meta?: unknown): void {
    if (!config.napcat.actionLog.enabled) return;
    const threshold = this.getActionLogThreshold(config.napcat.actionLog.level);
    const current = this.getActionLogThreshold(level);
    if (current > threshold) return;

    const args: [string, ...unknown[]] = meta === undefined ? [message] : [message, meta];
    switch (level) {
      case "error":
        console.error(...args);
        return;
      case "warn":
        console.warn(...args);
        return;
      case "info":
        console.info(...args);
        return;
      case "debug":
        console.debug(...args);
    }
  }

  private getActionLogThreshold(level: ActionLogLevel): number {
    switch (level) {
      case "error":
        return 0;
      case "warn":
        return 1;
      case "info":
        return 2;
      case "debug":
        return 3;
    }
  }

  private formatActionError(action: string, response: ActionResponse): Error {
    const parts = [`action=${action}`];
    if (response.status !== undefined) parts.push(`status=${response.status}`);
    if (response.retcode !== undefined) parts.push(`retcode=${response.retcode}`);
    if (typeof response.msg === "string" && response.msg) parts.push(`msg=${response.msg}`);
    if (typeof response.wording === "string" && response.wording) {
      parts.push(`wording=${response.wording}`);
    }
    return new Error(`[action] ${parts.join(" ")}`);
  }

  private failPendingActions(error: Error): void {
    for (const [echo, pending] of this.pendingActions.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pendingActions.delete(echo);
    }
  }

  private failQueuedActions(error: Error): void {
    while (this.actionQueue.length > 0) {
      const queued = this.actionQueue.shift();
      if (!queued) continue;
      queued.reject(error);
    }
  }

  private shouldRetryAction(error: Error): boolean {
    const text = error.message;
    return (
      text.includes("timeout") ||
      text.includes("WebSocket 未连接") ||
      text.includes("WebSocket closed") ||
      text.includes("ECONNRESET") ||
      text.includes("EPIPE")
    );
  }

  private getRetryDelayMs(currentAttempt: number): number {
    return calculateActionRetryDelayMs(
      this.actionRetryBaseDelayMs,
      this.actionRetryMaxDelayMs,
      currentAttempt,
    );
  }

  private async reserveRateLimitSlot(): Promise<void> {
    const task = this.rateLimitLock.then(() => this.waitForRateLimitWindow());
    this.rateLimitLock = task.catch(() => undefined);
    await task;
  }

  private async waitForRateLimitWindow(): Promise<void> {
    while (true) {
      const now = Date.now();
      this.actionSendTimestamps = this.actionSendTimestamps.filter((ts) => now - ts < 1000);
      if (this.actionSendTimestamps.length < this.actionRateLimitPerSecond) {
        this.actionSendTimestamps.push(now);
        return;
      }

      const oldest = this.actionSendTimestamps[0];
      const waitMs = Math.max(1, 1000 - (now - oldest));
      this.rateLimitWaitMsTotal += waitMs;
      await this.delayRetry(waitMs);
    }
  }

  private async delayRetry(delayMs: number): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    });
  }

  private toError(error: unknown): Error {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }

  private isWsOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  private decodeMessage(data: WebSocket.RawData): string {
    if (typeof data === "string") {
      return data;
    }
    if (Buffer.isBuffer(data)) {
      return data.toString();
    }
    if (Array.isArray(data)) {
      return Buffer.concat(data).toString();
    }
    return Buffer.from(data).toString();
  }
}
