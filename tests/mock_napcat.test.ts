import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

type ActionPayload = {
  action?: string;
  params?: Record<string, unknown>;
  echo?: string;
};

type ReceivedAction = {
  action: string;
  params: Record<string, unknown>;
  echo: string;
  receivedAt: number;
};

type ActionWaiter = {
  predicate: (action: ReceivedAction) => boolean;
  resolve: (action: ReceivedAction) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

async function createMockServer() {
  const wss = new WebSocketServer({ port: 0 });
  await once(wss, "listening");
  const address = wss.address() as AddressInfo;
  const actions: ReceivedAction[] = [];
  const waiters: ActionWaiter[] = [];
  const clients = new Set<WebSocket>();
  const actionCounts = new Map<string, number>();

  const maybeResolveWaiters = (action: ReceivedAction) => {
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (!waiter.predicate(action)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(i, 1);
      waiter.resolve(action);
    }
  };

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => {
      clients.delete(ws);
    });
    ws.on("message", (data) => {
      const raw = decodeMessage(data);
      let payload: ActionPayload;
      try {
        payload = JSON.parse(raw);
      } catch {
        return;
      }

      if (!payload.action || typeof payload.action !== "string") {
        return;
      }

      const params = payload.params && typeof payload.params === "object" ? payload.params : {};
      const echo = typeof payload.echo === "string" ? payload.echo : "";
      const action: ReceivedAction = {
        action: payload.action,
        params,
        echo,
        receivedAt: Date.now(),
      };
      const count = (actionCounts.get(payload.action) ?? 0) + 1;
      actionCounts.set(payload.action, count);
      actions.push(action);
      maybeResolveWaiters(action);

      if (payload.action === "no_reply") {
        return;
      }

      if (payload.action === "flaky_timeout_once" && count === 1) {
        return;
      }

      if (payload.action === "fail_action") {
        ws.send(
          JSON.stringify({
            status: "failed",
            retcode: 100,
            msg: "mock fail",
            echo: payload.echo,
          }),
        );
        return;
      }

      if (payload.action === "delayed_ok") {
        setTimeout(() => {
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(
            JSON.stringify({
              status: "ok",
              retcode: 0,
              data: { ok: true },
              echo: payload.echo,
            }),
          );
        }, 120);
        return;
      }

      ws.send(
        JSON.stringify({
          status: "ok",
          retcode: 0,
          data: { ok: true },
          echo: payload.echo,
        }),
      );
    });
  });

  const waitForConnection = async () => {
    const existing = clients.values().next().value as WebSocket | undefined;
    if (existing) return existing;
    const [ws] = (await once(wss, "connection")) as [WebSocket];
    return ws;
  };

  const waitForAction = (predicate: ActionWaiter["predicate"], timeoutMs = 1000) => {
    const existing = actions.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<ReceivedAction>((resolve, reject) => {
      let waiter: ActionWaiter;
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        const error = new Error("waitForAction timeout");
        reject(error);
      }, timeoutMs);
      waiter = { predicate, resolve, reject, timer };
      waiters.push(waiter);
    });
  };

  const sendEvent = (event: Record<string, unknown>) => {
    const payload = JSON.stringify(event);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  };

  const close = () =>
    new Promise<void>((resolve) => {
      wss.close(() => resolve());
    });

  return {
    wss,
    port: address.port,
    actions,
    waitForConnection,
    waitForAction,
    sendEvent,
    close,
  };
}

function decodeMessage(data: WebSocket.RawData): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}

function messageToText(message: unknown): string {
  if (typeof message === "string") return message;
  if (Array.isArray(message)) {
    return message
      .map((segment) => {
        if (!segment || typeof segment !== "object") return "";
        const type = (segment as { type?: string }).type;
        if (type !== "text") return "";
        const data = (segment as { data?: { text?: unknown } }).data;
        const textValue = data?.text;
        return typeof textValue === "string" ? textValue : "";
      })
      .join("")
      .trim();
  }
  return "";
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function waitForClientOpen(client: unknown, timeoutMs = 1000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = (client as { ws?: WebSocket | null }).ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      return;
    }
    await delay(10);
  }
  throw new Error("client open timeout");
}

type ActionQueueOverrides = Partial<{
  concurrency: number;
  maxSize: number;
  rateLimitPerSecond: number;
  retryAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}>;

async function withActionQueueOverrides<T>(
  overrides: ActionQueueOverrides,
  fn: () => Promise<T>,
): Promise<T> {
  const { config } = await import("../src/config");
  const previous = { ...config.napcat.actionQueue };
  Object.assign(config.napcat.actionQueue, overrides);
  try {
    return await fn();
  } finally {
    Object.assign(config.napcat.actionQueue, previous);
  }
}

async function main() {
  const server = await createMockServer();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-"));
  process.env.NAPCAT_WS_URL = `ws://127.0.0.1:${server.port}`;
  process.env.NAPCAT_ACTION_TIMEOUT_MS = "200";
  process.env.NAPCAT_ACTION_LOG_ENABLED = "false";
  process.env.NAPCAT_ACTION_QUEUE_CONCURRENCY = "1";
  process.env.NAPCAT_ACTION_QUEUE_MAX_SIZE = "200";
  process.env.NAPCAT_ACTION_RATE_LIMIT_PER_SECOND = "20";
  process.env.NAPCAT_ACTION_RETRY_ATTEMPTS = "1";
  process.env.NAPCAT_ACTION_RETRY_BASE_DELAY_MS = "200";
  process.env.NAPCAT_ACTION_RETRY_MAX_DELAY_MS = "1500";
  process.env.SCHEDULE_INTERVAL_MS = "600000";
  process.env.BOT_CONFIG_PATH = path.join(tmpDir, "config.json");
  process.env.ROOT_USER_ID = "11111";
  process.env.GROUP_ENABLED_DEFAULT = "true";
  process.env.COMMAND_COOLDOWN_MS = "0";
  process.env.GEMINI_API_KEY = "";
  process.env.CHAT_ENABLED = "true";
  process.env.CHAT_BOT_ALIASES = "小o,ovo";
  process.env.CHAT_EMPTY_REPLY_FALLBACK = "刚卡了";
  process.env.CHAT_MEDIA_ENABLED = "true";
  process.env.CHAT_MEDIA_MAX_IMAGES = "2";
  process.env.CHAT_MEMORY_ENABLED = "true";
  process.env.CHAT_MEMORY_PATH = path.join(tmpDir, "chat_memory.json");

  const { NapcatClient } = await import("../src/napcat/client");
  const client = new NapcatClient();
  client.connect();
  await server.waitForConnection();
  await waitForClientOpen(client);

  try {
    await runTest("sendAction resolves with ok", async () => {
      const response = await client.sendAction("get_status");
      assert.equal(response.status, "ok");
      assert.equal(response.retcode, 0);
    });

    await runTest("sendActionNoWait sends without waiting", async () => {
      await client.sendActionNoWait("no_wait_action", { foo: 1 });
      const action = await server.waitForAction((item) => item.action === "no_wait_action");
      assert.deepEqual(action.params, { foo: 1 });
    });

    await runTest("message event triggers /ping reply", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/ping",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message) === "pong",
      );
      assert.equal(messageToText(action.params.message), "pong");
    });

    await runTest("group /echo via message segments", async () => {
      server.sendEvent({
        time: Math.floor(Date.now() / 1000),
        self_id: 99999,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 777,
        group_id: 54321,
        user_id: 11111,
        anonymous: null,
        message: [
          { type: "reply", data: { id: "776" } },
          { type: "at", data: { qq: "all" } },
          { type: "text", data: { text: "/echo hello" } },
        ],
        raw_message: "[CQ:reply,id=776][CQ:at,qq=all]/echo hello",
        font: 0,
        sender: {
          user_id: 11111,
          nickname: "Tester",
          role: "member",
        },
      });

      const action = await server.waitForAction(
        (item) => item.action === "send_group_msg" && item.params.group_id === 54321,
      );
      assert.equal(messageToText(action.params.message), "hello");
    });

    await runTest("raw_message /help fallback works", async () => {
      server.sendEvent({
        time: Math.floor(Date.now() / 1000),
        self_id: 99999,
        post_type: "message",
        message_type: "private",
        sub_type: "friend",
        message_id: 778,
        user_id: 11111,
        raw_message: "/help",
        sender: {
          user_id: 11111,
          nickname: "Tester2",
        },
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message) ===
            "/ping\n/echo <text>\n/问 <问题>\n/help\n/status\n/config\n/group on|off [group_id]\n/cooldown [ms]\n/帮助\n/天气 <城市>",
      );
      assert.equal(
        messageToText(action.params.message),
        "/ping\n/echo <text>\n/问 <问题>\n/help\n/status\n/config\n/group on|off [group_id]\n/cooldown [ms]\n/帮助\n/天气 <城市>",
      );
    });

    await runTest("/status returns runtime summary", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/status",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message).includes("connected=true"),
      );
      const statusText = messageToText(action.params.message);
      assert.equal(true, statusText.includes("pending="));
      assert.equal(true, statusText.includes("queue_overflow_count="));
      assert.equal(true, statusText.includes("retry_count="));
      assert.equal(true, statusText.includes("rate_limit_wait_ms_total="));
    });

    await runTest("user command /帮助 is available to non-root users", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        self_id: 99999,
        message: "/帮助",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 22222 &&
          messageToText(item.params.message) === "/帮助\n/天气 <城市>",
      );
      assert.equal(messageToText(action.params.message), "/帮助\n/天气 <城市>");
    });

    await runTest("user command /天气 without location returns usage", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        self_id: 99999,
        message: "/天气",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 22222 &&
          messageToText(item.params.message) === "用法：/天气 <城市>",
      );
      assert.equal(messageToText(action.params.message), "用法：/天气 <城市>");
    });

    await runTest("non-root user command /问 is denied", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        self_id: 99999,
        message: "/问 你好",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 22222 &&
          messageToText(item.params.message) === "无权限",
      );
      assert.equal(messageToText(action.params.message), "无权限");
    });

    await runTest("root command /问 without prompt returns usage", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/问",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message) === "用法：/问 <问题>",
      );
      assert.equal(messageToText(action.params.message), "用法：/问 <问题>");
    });

    await runTest("root command /问 returns config hint when key missing", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/问 你好",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message).includes("GEMINI_API_KEY"),
      );
      assert.equal(true, messageToText(action.params.message).includes("GEMINI_API_KEY"));
    });

    await runTest("weather formatter follows python template", async () => {
      const { formatWeatherInfo } = await import("../src/utils/weather");
      const formatted = formatWeatherInfo({
        code: 200,
        msg: "success",
        data: {
          weather: {
            location: {
              name: "beijing",
              state: "北京",
              coordinates: { lat: 39.90458, lon: 116.40699 },
            },
            current: {
              temperature: -7,
              feels_like: 5,
              condition: "大部晴朗",
              humidity: 38,
              wind: { direction: "西南风", speed: "1级" },
            },
            air_quality: { aqi: 30 },
            metadata: { last_updated: "2026-02-06T15:07:56+00:00" },
          },
          forecast: [
            { date: "周五", high_temp: -4, low_temp: -9 },
            { date: "周六", high_temp: 0, low_temp: -10 },
          ],
        },
      });

      assert.equal(formatted.includes("北京 · BEIJING"), true);
      assert.equal(formatted.includes("☀️ 当前天气: 大部晴朗"), true);
      assert.equal(formatted.includes("温度: -7°C (体感 5°C)"), true);
      assert.equal(formatted.includes("风况: 西南风 1级"), true);
      assert.equal(formatted.includes("空气质量: AQI 30"), true);
      assert.equal(formatted.includes("优"), true);
      assert.equal(formatted.includes("今日与未来四天天气预报:"), true);
      assert.equal(formatted.includes("周五:"), true);
      assert.equal(formatted.includes("-9°C ~ -4°C"), true);
      assert.equal(formatted.includes("数据更新于: 2026-02-06 23:07:56"), true);
    });

    await runTest("group named-bot message triggers chat fallback", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "group",
        group_id: 65432,
        user_id: 33333,
        self_id: 99999,
        message: "小o 在吗",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_group_msg" &&
          item.params.group_id === 65432 &&
          messageToText(item.params.message) === "刚卡了",
      );
      assert.equal(messageToText(action.params.message), "刚卡了");
    });

    await runTest("group plain text without trigger stays silent", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "group",
        group_id: 65433,
        user_id: 33334,
        self_id: 99999,
        message: "今天吃什么",
      });

      await assert.rejects(
        () =>
          server.waitForAction(
            (item) =>
              item.action === "send_group_msg" &&
              item.params.group_id === 65433,
            180,
          ),
        /waitForAction timeout/,
      );
    });

    await runTest("private image message triggers multimodal chat fallback", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 33335,
        self_id: 99999,
        message: [
          {
            type: "image",
            data: {
              file: "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=",
            },
          },
        ],
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 33335 &&
          messageToText(item.params.message) === "刚卡了",
      );
      assert.equal(messageToText(action.params.message), "刚卡了");
    });

    await runTest("permission middleware blocks non-root users", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 22222,
        self_id: 99999,
        message: "/ping",
      });

      const denied = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 22222 &&
          messageToText(item.params.message) === "无权限",
      );
      assert.equal(messageToText(denied.params.message), "无权限");
    });

    await runTest("/config returns config for root", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/config",
      });

      const action = await server.waitForAction(
        (item) =>
          item.action === "send_private_msg" &&
          item.params.user_id === 11111 &&
          messageToText(item.params.message).includes("rootUserId=11111"),
      );
      assert.equal(true, messageToText(action.params.message).includes("cooldownMs="));
    });

    await runTest("group middleware blocks commands when disabled", async () => {
      server.sendEvent({
        post_type: "message",
        message_type: "group",
        group_id: 54321,
        user_id: 11111,
        self_id: 99999,
        message: "/group off",
      });

      const disabled = await server.waitForAction(
        (item) =>
          item.action === "send_group_msg" &&
          item.params.group_id === 54321 &&
          messageToText(item.params.message) === "已关闭群 54321",
      );
      assert.equal(messageToText(disabled.params.message), "已关闭群 54321");

      server.sendEvent({
        post_type: "message",
        message_type: "group",
        group_id: 54321,
        user_id: 22222,
        self_id: 99999,
        message: "/ping",
      });

      const blocked = await server.waitForAction(
        (item) =>
          item.action === "send_group_msg" &&
          item.params.group_id === 54321 &&
          messageToText(item.params.message) === "本群已关闭",
      );
      assert.equal(messageToText(blocked.params.message), "本群已关闭");

      server.sendEvent({
        post_type: "message",
        message_type: "group",
        group_id: 54321,
        user_id: 11111,
        self_id: 99999,
        message: "/group on",
      });

      const enabled = await server.waitForAction(
        (item) =>
          item.action === "send_group_msg" &&
          item.params.group_id === 54321 &&
          messageToText(item.params.message) === "已开启群 54321",
      );
      assert.equal(messageToText(enabled.params.message), "已开启群 54321");
    });

    await runTest("cooldown middleware limits repeated commands", async () => {
      const waitRootPrivateText = async (
        matcher: (text: string) => boolean,
      ) => {
        await server.waitForAction(
          (item) =>
            item.action === "send_private_msg" &&
            item.params.user_id === 11111 &&
            matcher(messageToText(item.params.message)),
          2500,
        );
      };

      server.actions.length = 0;
      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/cooldown 1500",
      });
      await waitRootPrivateText((text) => text === "已设置冷却时间 1500ms");

      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/ping",
      });
      await waitRootPrivateText((text) => text === "pong");

      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/ping",
      });
      await waitRootPrivateText((text) => text.startsWith("冷却中"));

      server.sendEvent({
        post_type: "message",
        message_type: "private",
        user_id: 11111,
        self_id: 99999,
        message: "/cooldown 0",
      });
      await waitRootPrivateText((text) => text === "已设置冷却时间 0ms");
    });

    await runTest("action queue serializes send order", async () => {
      server.actions.length = 0;

      const first = client.sendAction("delayed_ok", { seq: 1 });
      const second = client.sendAction("get_status", { seq: 2 });
      await Promise.all([first, second]);

      const delayedAction = server.actions.find(
        (item) => item.action === "delayed_ok" && item.params.seq === 1,
      );
      const followAction = server.actions.find(
        (item) => item.action === "get_status" && item.params.seq === 2,
      );

      assert.ok(delayedAction);
      assert.ok(followAction);
      assert.equal(true, followAction.receivedAt - delayedAction.receivedAt >= 80);
    });

    await runTest("action queue overflow increments runtime counter", async () => {
      await withActionQueueOverrides(
        {
          concurrency: 1,
          maxSize: 1,
          rateLimitPerSecond: 200,
          retryAttempts: 0,
        },
        async () => {
          const tunedClient = new NapcatClient();
          tunedClient.connect();
          await waitForClientOpen(tunedClient);

          try {
            const first = tunedClient.sendAction("delayed_ok", { seq: "q1" });
            const second = tunedClient.sendAction("delayed_ok", { seq: "q2" });

            await assert.rejects(
              () => tunedClient.sendAction("get_status", { seq: "overflow" }),
              /queue_overflow/,
            );

            await Promise.all([first, second]);
            const runtime = tunedClient.getRuntimeStatus();
            assert.equal(runtime.queueOverflowCount >= 1, true);
          } finally {
            await tunedClient.shutdown();
            await delay(50);
          }
        },
      );
    });

    await runTest("action queue concurrency can be increased", async () => {
      await withActionQueueOverrides(
        {
          concurrency: 2,
          rateLimitPerSecond: 200,
          retryAttempts: 0,
        },
        async () => {
          const tunedClient = new NapcatClient();
          tunedClient.connect();
          await waitForClientOpen(tunedClient);

          try {
            server.actions.length = 0;
            await Promise.all([
              tunedClient.sendAction("delayed_ok", { seq: "c1" }),
              tunedClient.sendAction("delayed_ok", { seq: "c2" }),
            ]);

            const delayedActions = server.actions
              .filter(
                (item) =>
                  item.action === "delayed_ok" &&
                  (item.params.seq === "c1" || item.params.seq === "c2"),
              )
              .sort((a, b) => a.receivedAt - b.receivedAt);

            assert.equal(delayedActions.length, 2);
            assert.equal(Math.abs(delayedActions[1].receivedAt - delayedActions[0].receivedAt) < 80, true);
          } finally {
            await tunedClient.shutdown();
            await delay(50);
          }
        },
      );
    });

    await runTest("action queue rate limit throttles bursts", async () => {
      await withActionQueueOverrides(
        {
          concurrency: 3,
          rateLimitPerSecond: 2,
          retryAttempts: 0,
        },
        async () => {
          const tunedClient = new NapcatClient();
          tunedClient.connect();
          await waitForClientOpen(tunedClient);

          try {
            server.actions.length = 0;
            await Promise.all([
              tunedClient.sendAction("rate_limit_probe", { seq: 1 }),
              tunedClient.sendAction("rate_limit_probe", { seq: 2 }),
              tunedClient.sendAction("rate_limit_probe", { seq: 3 }),
            ]);

            const probes = server.actions
              .filter((item) => item.action === "rate_limit_probe")
              .sort((a, b) => a.receivedAt - b.receivedAt);

            assert.equal(probes.length, 3);
            assert.equal(probes[2].receivedAt - probes[0].receivedAt >= 850, true);
            const runtime = tunedClient.getRuntimeStatus();
            assert.equal(runtime.rateLimitWaitMsTotal >= 850, true);
          } finally {
            await tunedClient.shutdown();
            await delay(50);
          }
        },
      );
    });

    await runTest("action timeout retries once on transient failure", async () => {
      server.actions.length = 0;
      const retryCountBefore = client.getRuntimeStatus().retryCount;

      const response = await client.sendAction("flaky_timeout_once", { marker: 1 });
      assert.equal(response.status, "ok");

      const sent = server.actions.filter(
        (item) => item.action === "flaky_timeout_once" && item.params.marker === 1,
      );
      assert.equal(sent.length, 2);
      const retryCountAfter = client.getRuntimeStatus().retryCount;
      assert.equal(retryCountAfter > retryCountBefore, true);
    });

    await runTest("action timeout rejects", async () => {
      await assert.rejects(
        () => client.sendAction("no_reply"),
        /timeout/,
      );
    });

    await runTest("action retcode failure rejects", async () => {
      await assert.rejects(
        () => client.sendAction("fail_action"),
        /retcode=100/,
      );
    });

    await runTest("command registry supports register and parse", async () => {
      const { getCommandRegistry, parseCommand, registerCommand } = await import(
        "../src/napcat/commands/registry"
      );
      const beforeSize = getCommandRegistry().length;
      const keyword = `/custom_${Date.now()}`;

      registerCommand({
        name: "custom_test",
        parse: (message) => (message.trim() === keyword ? {} : null),
        execute: async (context) => {
          await context.sendText("ok");
        },
      });

      assert.equal(getCommandRegistry().length, beforeSize + 1);
      const parsed = parseCommand(keyword);
      assert.equal(parsed?.definition.name, "custom_test");
    });
  } finally {
    await client.shutdown();
    await delay(50);
    await server.close();
  }
}

void main();
