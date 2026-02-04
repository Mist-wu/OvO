import { randomUUID } from "crypto";
import WebSocket from "ws";

import { config } from "../config";
import { scheduleLoop } from "../utils/schedule_tasks";
import { handleEvent } from "./handlers";

export class NapcatClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private scheduleTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastPongAt = Date.now();
  private shuttingDown = false;

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
      this.cleanup();
      this.scheduleReconnect();
    });

    ws.on("error", (error) => {
      console.error("WebSocket 错误:", error);
    });
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
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

  sendPrivateText(userId: number, message: string): Promise<void> {
    return this.sendAction("send_private_msg", { user_id: userId, message });
  }

  sendGroupText(groupId: number, message: string): Promise<void> {
    return this.sendAction("send_group_msg", { group_id: groupId, message });
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

    if ("echo" in event) {
      console.debug("收到 action 回包:", event);
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
