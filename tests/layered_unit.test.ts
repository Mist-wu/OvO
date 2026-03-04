import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseCommand } from "../src/napcat/commands/registry";
import { ActivityStore } from "../src/activity/store";
import {
  buildActionPayload,
  createGetMsgParams,
  createGetStatusParams,
  createSendGroupMsgParams,
  createSendPrivateMsgParams,
  createSetFriendAddRequestParams,
  createSetGroupAddRequestParams,
} from "../src/napcat/actions";
import { calculateActionRetryDelayMs } from "../src/napcat/client";
import {
  isMessageEvent,
  isMetaEvent,
  isNoticeEvent,
  isRequestEvent,
  type OneBotEvent,
} from "../src/napcat/commands/types";
import { ExternalCallError, runExternalCall } from "../src/utils/external_call";
import { ConfigStore } from "../src/storage/config_store";
import { configStore } from "../src/storage/config_store";
import { cooldownMiddleware } from "../src/napcat/commands/middleware";
import {
  buildGeminiGenerateContentConfig,
  extractGeminiGroundingMetadataFromResponse,
} from "../src/llm/gemini";

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function main() {
  await runTest("event guards discriminate by post_type", async () => {
    const messageEvent = { post_type: "message", user_id: 1 } as OneBotEvent;
    const noticeEvent = { post_type: "notice" } as OneBotEvent;
    const requestEvent = { post_type: "request" } as OneBotEvent;
    const metaEvent = { post_type: "meta_event" } as OneBotEvent;

    assert.equal(isMessageEvent(messageEvent), true);
    assert.equal(isNoticeEvent(messageEvent), false);
    assert.equal(isRequestEvent(messageEvent), false);
    assert.equal(isMetaEvent(messageEvent), false);

    assert.equal(isNoticeEvent(noticeEvent), true);
    assert.equal(isRequestEvent(requestEvent), true);
    assert.equal(isMetaEvent(metaEvent), true);
  });

  await runTest("command registry keeps /help as root and /帮助 as user", async () => {
    const helpRootCommand = parseCommand("/help");
    assert.ok(helpRootCommand);
    assert.equal(helpRootCommand?.definition.name, "help");
    assert.equal(helpRootCommand?.definition.access ?? "root", "root");

    const helpCommand = parseCommand("/帮助");
    assert.ok(helpCommand);
    assert.equal(helpCommand?.definition.name, "user_help");
    assert.equal(helpCommand?.definition.access, "user");
  });

  await runTest("points commands parse supports numeric and @target forms", async () => {
    const rechargeNumeric = parseCommand("/充值 10 123456");
    assert.ok(rechargeNumeric);
    assert.equal(rechargeNumeric?.definition.name, "recharge_points");
    assert.deepEqual(rechargeNumeric?.payload, { points: 10, targetUserId: 123456 });

    const rechargeMention = parseCommand("/充值 10");
    assert.ok(rechargeMention);
    assert.equal(rechargeMention?.definition.name, "recharge_points");
    assert.deepEqual(rechargeMention?.payload, { points: 10 });

    const transferNumeric = parseCommand("/转积分 8 654321");
    assert.ok(transferNumeric);
    assert.equal(transferNumeric?.definition.name, "transfer_points");
    assert.deepEqual(transferNumeric?.payload, { points: 8, targetUserId: 654321 });

    const transferMention = parseCommand("/转积分 8");
    assert.ok(transferMention);
    assert.equal(transferMention?.definition.name, "transfer_points");
    assert.deepEqual(transferMention?.payload, { points: 8 });

    assert.equal(parseCommand("/充值 0 123456"), null);
    assert.equal(parseCommand("/转积分 0 123456"), null);
  });

  await runTest("activity store transfer points updates balances and validates params", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-points-transfer-"));
    const filePath = path.join(tmpDir, "activity_stats.json");
    const store = new ActivityStore(filePath);

    const recharged = store.addUserPoints({
      userId: 9001,
      points: 30,
      userName: "转出方",
      now: 1700000000000,
    });
    assert.equal(recharged.totalPoints, 30);

    const transferred = store.transferUserPoints({
      fromUserId: 9001,
      toUserId: 9002,
      points: 12,
      fromUserName: "转出方",
      toUserName: "转入方",
      now: 1700000001000,
    });
    assert.equal(transferred.transferredPoints, 12);
    assert.equal(transferred.fromTotalPoints, 18);
    assert.equal(transferred.toTotalPoints, 12);

    const fromSnapshot = store.getUserPoints({ userId: 9001 });
    const toSnapshot = store.getUserPoints({ userId: 9002 });
    assert.equal(fromSnapshot.totalPoints, 18);
    assert.equal(toSnapshot.totalPoints, 12);

    assert.throws(
      () => store.transferUserPoints({ fromUserId: 9001, toUserId: 9002, points: 99 }),
      /insufficient points/,
    );
    assert.throws(
      () => store.transferUserPoints({ fromUserId: 9001, toUserId: 9001, points: 1 }),
      /invalid transfer params/,
    );
  });

  await runTest("action helpers produce expected payloads", async () => {
    const message = [{ type: "text", data: { text: "hello" } }];

    const privateParams = createSendPrivateMsgParams(123, message);
    assert.deepEqual(privateParams, { user_id: 123, message });

    const groupParams = createSendGroupMsgParams(456, message);
    assert.deepEqual(groupParams, { group_id: 456, message });

    const getStatus = createGetStatusParams();
    assert.deepEqual(getStatus, {});
    const getMsg = createGetMsgParams("7788");
    assert.deepEqual(getMsg, { message_id: "7788" });

    const groupRequest = createSetGroupAddRequestParams("flag1", "add", true);
    assert.deepEqual(groupRequest, { flag: "flag1", sub_type: "add", approve: true });

    const friendRequest = createSetFriendAddRequestParams("flag2", true);
    assert.deepEqual(friendRequest, { flag: "flag2", approve: true });

    const payload = buildActionPayload("get_status", getStatus, "echo-1");
    assert.deepEqual(payload, { action: "get_status", params: {}, echo: "echo-1" });
  });

  await runTest("action retry delay follows exponential backoff and cap", async () => {
    assert.equal(calculateActionRetryDelayMs(100, 1500, 0), 100);
    assert.equal(calculateActionRetryDelayMs(100, 1500, 1), 200);
    assert.equal(calculateActionRetryDelayMs(100, 1500, 2), 400);
    assert.equal(calculateActionRetryDelayMs(100, 1500, 8), 1500);
  });

  await runTest("config store migrates legacy payload to versioned config", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-config-"));
    const filePath = path.join(tmpDir, "bot_config.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        groupEnabled: { "12345": false },
        cooldownMs: 777,
      }),
      "utf8",
    );

    const store = new ConfigStore(filePath, {
      cooldownMs: 0,
    });

    assert.equal(store.getCooldownMs(), 777);

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: number;
      groupEnabled?: Record<string, boolean>;
      cooldownMs?: number;
    };
    assert.equal(persisted.version, 2);
    assert.equal("groupEnabled" in persisted, false);
    assert.equal(persisted.cooldownMs, 777);
  });

  await runTest("cooldown middleware blocks repeated command in cooldown window", async () => {
    const previousCooldown = configStore.getCooldownMs();
    const notifications: string[] = [];
    let executed = 0;

    const runCooldown = async (userId: number, commandName = "ping") => {
      const context = {
        userId,
        groupId: undefined,
        messageType: "private",
        isRoot: true,
        command: {
          definition: {
            name: commandName,
          },
        },
        sendText: async (text: string) => {
          notifications.push(text);
        },
      } as Parameters<typeof cooldownMiddleware>[0];

      await cooldownMiddleware(context, async () => {
        executed += 1;
      });
    };

    try {
      configStore.setCooldownMs(1000);
      await runCooldown(9101);
      await runCooldown(9101);

      assert.equal(executed, 1);
      assert.equal(notifications.some((item) => item.includes("冷却中")), true);
    } finally {
      configStore.setCooldownMs(0);
      await runCooldown(99999);
      configStore.setCooldownMs(previousCooldown);
    }
  });

  await runTest("external call retries transient failures", async () => {
    let attempts = 0;
    const result = await runExternalCall(
      {
        service: "unit",
        operation: "retry",
        timeoutMs: 200,
        retries: 1,
        retryDelayMs: 5,
      },
      async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("ECONNRESET");
        }
        return "ok";
      },
    );

    assert.equal(result, "ok");
    assert.equal(attempts, 2);
  });

  await runTest("external call times out with normalized error", async () => {
    await assert.rejects(
      () =>
        runExternalCall(
          {
            service: "unit",
            operation: "timeout",
            timeoutMs: 20,
            retries: 0,
          },
          async () => {
            await delay(80);
            return "slow";
          },
        ),
      (error) => {
        assert.equal(error instanceof ExternalCallError, true);
        assert.equal(String(error).includes("timeout"), true);
        return true;
      },
    );
  });

  await runTest("external call opens circuit and uses fallback", async () => {
    let attempts = 0;
    const invoke = () =>
      runExternalCall(
        {
          service: "unit",
          operation: "circuit_with_fallback",
          timeoutMs: 100,
          retries: 0,
          circuitBreaker: {
            enabled: true,
            key: "unit:circuit_with_fallback",
            failureThreshold: 1,
            openMs: 1000,
          },
          fallback: () => "degraded",
        },
        async () => {
          attempts += 1;
          throw new Error("status=503");
        },
      );

    const first = await invoke();
    const second = await invoke();

    assert.equal(first, "degraded");
    assert.equal(second, "degraded");
    assert.equal(attempts, 1);
  });

  await runTest("external call circuit open returns typed error when no fallback", async () => {
    await assert.rejects(
      () =>
        runExternalCall(
          {
            service: "unit",
            operation: "circuit_without_fallback",
            timeoutMs: 100,
            retries: 0,
            circuitBreaker: {
              enabled: true,
              key: "unit:circuit_without_fallback",
              failureThreshold: 1,
              openMs: 1000,
            },
          },
          async () => {
            throw new Error("status=503");
          },
        ),
      (error) => {
        assert.equal(error instanceof ExternalCallError, true);
        assert.equal((error as ExternalCallError).reason, "call_failed");
        return true;
      },
    );

    await assert.rejects(
      () =>
        runExternalCall(
          {
            service: "unit",
            operation: "circuit_without_fallback",
            timeoutMs: 100,
            retries: 0,
            circuitBreaker: {
              enabled: true,
              key: "unit:circuit_without_fallback",
              failureThreshold: 1,
              openMs: 1000,
            },
          },
          async () => "should_not_run",
        ),
      (error) => {
        assert.equal(error instanceof ExternalCallError, true);
        assert.equal((error as ExternalCallError).reason, "circuit_open");
        return true;
      },
    );
  });

  await runTest("external call concurrency gate serializes by key", async () => {
    let active = 0;
    let maxActive = 0;

    const runTask = () =>
      runExternalCall(
        {
          service: "unit",
          operation: "serial",
          timeoutMs: 200,
          retries: 0,
          concurrency: 1,
          concurrencyKey: "unit:serial",
        },
        async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await delay(40);
          active -= 1;
          return "ok";
        },
      );

    await Promise.all([runTask(), runTask(), runTask()]);
    assert.equal(maxActive, 1);
  });

  await runTest("gemini config merges system instruction and grounding tool", async () => {
    const full = buildGeminiGenerateContentConfig({
      systemPrompt: "你是一个助手",
      enableGrounding: true,
    });
    assert.deepEqual(full, {
      systemInstruction: "你是一个助手",
      tools: [{ googleSearch: {} }],
    });

    const groundingOnly = buildGeminiGenerateContentConfig({
      systemPrompt: "   ",
      enableGrounding: true,
    });
    assert.deepEqual(groundingOnly, {
      tools: [{ googleSearch: {} }],
    });

    const empty = buildGeminiGenerateContentConfig({
      systemPrompt: "",
      enableGrounding: false,
    });
    assert.equal(empty, undefined);
  });

  await runTest("gemini grounding metadata extraction parses queries and sources", async () => {
    const metadata = extractGeminiGroundingMetadataFromResponse({
      candidates: [
        {
          groundingMetadata: {
            webSearchQueries: [" latest Lyon score ", "latest Lyon score", ""],
            groundingChunks: [
              { web: { title: "Lyon Result", uri: "https://example.com/a" } },
              { web: { title: "Lyon Result", uri: "https://example.com/a" } },
              { web: { title: "Only Title" } },
            ],
          },
        },
      ],
    });

    assert.ok(metadata);
    assert.deepEqual(metadata?.webSearchQueries, ["latest Lyon score"]);
    assert.deepEqual(metadata?.sources, [
      { title: "Lyon Result", url: "https://example.com/a" },
      { title: "Only Title", url: undefined },
    ]);
    assert.equal(metadata?.usedSearch, true);

    const none = extractGeminiGroundingMetadataFromResponse({
      candidates: [{ content: { parts: [{ text: "hello" }] } }],
    });
    assert.equal(none, undefined);
  });

  await runTest("logger.emitRaw bypasses global LOG_LEVEL gate", async () => {
    const { logger } = await import("../src/utils/logger");
    const originalLevel = logger.getLevel();
    const captured: Array<{ level: string; args: unknown[] }> = [];

    logger.setTransport((level, _ts, args) => {
      captured.push({ level, args });
    });

    try {
      logger.setLevel("warn");
      logger.info("should_be_filtered");
      assert.equal(
        captured.some((item) => item.args.includes("should_be_filtered")),
        false,
      );

      logger.emitRaw("info", "should_pass_through");
      assert.equal(
        captured.some((item) => item.args.includes("should_pass_through")),
        true,
      );

      logger.emitRaw("debug", "debug_raw");
      assert.equal(
        captured.some((item) => item.level === "debug" && item.args.includes("debug_raw")),
        true,
      );

      const countBefore = captured.length;
      logger.emitRaw("silent", "silent_msg");
      assert.equal(captured.length, countBefore);
    } finally {
      logger.setLevel(originalLevel);
      logger.resetTransport();
    }
  });

  await runTest("logger file tag uses Beijing standard time", async () => {
    const { formatBeijingTimeTag } = await import("../src/utils/logger");
    const fixedUtc = new Date("2026-01-01T16:05:09.000Z");
    const tag = formatBeijingTimeTag(fixedUtc);
    assert.equal(tag, "2026-01-02T00-05-09");
  });

  await runTest("logger writes to startup-time log file under logs directory", async () => {
    const { logger, getLogFilePath } = await import("../src/utils/logger");
    const originalLevel = logger.getLevel();
    const marker = `logger_file_marker_${Date.now()}`;

    try {
      logger.resetTransport();
      logger.setLevel("debug");
      logger.emitRaw("info", marker, { source: "unit-test" });

      const logFilePath = getLogFilePath();
      assert.equal(fs.existsSync(logFilePath), true);

      const content = fs.readFileSync(logFilePath, "utf8");
      assert.equal(content.includes(marker), true);
      assert.equal(content.includes("[INFO]"), true);
    } finally {
      logger.setLevel(originalLevel);
      logger.resetTransport();
    }
  });
}

void main();
