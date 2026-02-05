import { randomUUID } from "crypto";
import WebSocket from "ws";

import { config } from "../config";
import { scheduleLoop } from "../utils/schedule_tasks";
import { handleEvent } from "./handlers";
import { normalizeMessage, type MessageInput } from "./message";

type ActionResponse = {
  status?: string;
  retcode?: number;
  data?: unknown;
  msg?: string;
  wording?: string;
  echo?: string;
  [key: string]: unknown;
};

type ActionLogLevel = "error" | "warn" | "info" | "debug";

type PendingAction = {
  resolve: (response: ActionResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  action: string;
  startedAt: number;
};

export class NapcatClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private shuttingDown = false;
  private pendingActions = new Map<string, PendingAction>();

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

      if (config.targetQq) {
        try {
          await this.sendPrivateText(config.targetQq, "Bot成功启动");
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
    this.cleanup();
    if (this.ws) {
      this.ws.close(1000, "shutdown");
      this.ws = null;
    }
  }

  async sendAction(
    action: string,
    params: Record<string, unknown> = {},
    echo: string = randomUUID(),
  ): Promise<ActionResponse> {
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
      return this.sendAction("send_group_msg", { group_id: groupId, message: messageSegments });
    }

    if (typeof userId === "number") {
      return this.sendAction("send_private_msg", { user_id: userId, message: messageSegments });
    }

    throw new Error("sendMessage 需要 groupId 或 userId");
  }

  async sendActionNoWait(
    action: string,
    params: Record<string, unknown> = {},
    echo: string = randomUUID(),
  ): Promise<void> {
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

  sendPrivateText(userId: number, message: string): Promise<ActionResponse> {
    return this.sendMessage({ userId, message });
  }

  sendGroupText(groupId: number, message: string): Promise<ActionResponse> {
    return this.sendMessage({ groupId, message });
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
        await handleEvent(this, event as Record<string, unknown>);
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
