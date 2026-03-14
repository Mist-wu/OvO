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
import { parseRawCqMessage } from "../src/napcat/message_utils";
import { buildChatUserPrompt, formatSpeakerLabel } from "../src/chat/orchestrator";
import { ChatSessionStore } from "../src/chat/session";
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

    const groupStatusCommand = parseCommand("/群状态");
    assert.ok(groupStatusCommand);
    assert.equal(groupStatusCommand?.definition.name, "group_status");
    assert.equal(groupStatusCommand?.definition.access ?? "root", "root");
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

  await runTest("group feature toggle commands parse expected payload", async () => {
    const disableChat = parseCommand("/关闭聊天 123456");
    assert.ok(disableChat);
    assert.equal(disableChat?.definition.name, "disable_group_chat");
    assert.deepEqual(disableChat?.payload, { groupId: 123456 });
    const disableChatWithoutGroupId = parseCommand("/关闭聊天");
    assert.ok(disableChatWithoutGroupId);
    assert.equal(disableChatWithoutGroupId?.definition.name, "disable_group_chat");
    assert.deepEqual(disableChatWithoutGroupId?.payload, {});

    const enableChat = parseCommand("/开启聊天 123456");
    assert.ok(enableChat);
    assert.equal(enableChat?.definition.name, "enable_group_chat");
    assert.deepEqual(enableChat?.payload, { groupId: 123456 });
    const enableChatWithoutGroupId = parseCommand("/开启聊天");
    assert.ok(enableChatWithoutGroupId);
    assert.equal(enableChatWithoutGroupId?.definition.name, "enable_group_chat");
    assert.deepEqual(enableChatWithoutGroupId?.payload, {});

    const disableCommand = parseCommand("/关闭指令 123456");
    assert.ok(disableCommand);
    assert.equal(disableCommand?.definition.name, "disable_group_command");
    assert.deepEqual(disableCommand?.payload, { groupId: 123456 });
    const disableCommandWithoutGroupId = parseCommand("/关闭指令");
    assert.ok(disableCommandWithoutGroupId);
    assert.equal(disableCommandWithoutGroupId?.definition.name, "disable_group_command");
    assert.deepEqual(disableCommandWithoutGroupId?.payload, {});

    const enableCommand = parseCommand("/开启指令 123456");
    assert.ok(enableCommand);
    assert.equal(enableCommand?.definition.name, "enable_group_command");
    assert.deepEqual(enableCommand?.payload, { groupId: 123456 });
    const enableCommandWithoutGroupId = parseCommand("/开启指令");
    assert.ok(enableCommandWithoutGroupId);
    assert.equal(enableCommandWithoutGroupId?.definition.name, "enable_group_command");
    assert.deepEqual(enableCommandWithoutGroupId?.payload, {});

    assert.equal(parseCommand("/关闭聊天 0"), null);
    assert.equal(parseCommand("/开启指令 abc"), null);
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
    assert.equal(store.isGroupChatEnabled(12345), false);
    assert.equal(store.isGroupCommandEnabled(12345), false);

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: number;
      groupFeatures?: Record<string, { chatEnabled?: boolean; commandEnabled?: boolean }>;
      cooldownMs?: number;
    };
    assert.equal(persisted.version, 3);
    assert.deepEqual(persisted.groupFeatures?.["12345"], {
      chatEnabled: false,
      commandEnabled: false,
    });
    assert.equal(persisted.cooldownMs, 777);
  });

  await runTest("config store group feature toggles persist and collapse default entries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-config-group-features-"));
    const filePath = path.join(tmpDir, "bot_config.json");
    const store = new ConfigStore(filePath, {
      cooldownMs: 300,
    });

    assert.equal(store.isGroupChatEnabled(54321), true);
    assert.equal(store.isGroupCommandEnabled(54321), true);

    assert.equal(store.setGroupChatEnabled(54321, false), true);
    assert.equal(store.setGroupCommandEnabled(54321, false), true);
    assert.equal(store.isGroupChatEnabled(54321), false);
    assert.equal(store.isGroupCommandEnabled(54321), false);

    let persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      groupFeatures?: Record<string, { chatEnabled?: boolean; commandEnabled?: boolean }>;
    };
    assert.deepEqual(persisted.groupFeatures?.["54321"], {
      chatEnabled: false,
      commandEnabled: false,
    });

    assert.equal(store.setGroupChatEnabled(54321, true), true);
    assert.equal(store.setGroupCommandEnabled(54321, true), true);
    persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      groupFeatures?: Record<string, { chatEnabled?: boolean; commandEnabled?: boolean }>;
    };
    assert.equal(persisted.groupFeatures?.["54321"], undefined);
  });

  await runTest("chat session store expires old context and caps messages", async () => {
    const store = new ChatSessionStore({
      expireWindowMs: 120_000,
      maxTurns: 3,
    });

    store.appendUserMessage({
      scope: "private",
      userId: 1001,
      text: "第一句",
      eventTimeMs: 1_000,
    });
    store.appendAssistantMessage({
      scope: "private",
      userId: 1001,
      selfId: 9000,
      text: "第一句",
      eventTimeMs: 1_000,
    }, "第一答");
    store.appendUserMessage({
      scope: "private",
      userId: 1001,
      text: "第二句",
      eventTimeMs: 61_000,
    });
    store.appendAssistantMessage({
      scope: "private",
      userId: 1001,
      selfId: 9000,
      text: "第二句",
      eventTimeMs: 61_000,
    }, "第二答");
    store.appendUserMessage({
      scope: "private",
      userId: 1001,
      text: "第三句",
      eventTimeMs: 90_000,
    });
    store.appendAssistantMessage({
      scope: "private",
      userId: 1001,
      selfId: 9000,
      text: "第三句",
      eventTimeMs: 90_000,
    }, "第三答");
    store.appendUserMessage({
      scope: "private",
      userId: 1001,
      text: "第四句",
      eventTimeMs: 110_000,
    });
    store.appendAssistantMessage({
      scope: "private",
      userId: 1001,
      selfId: 9000,
      text: "第四句",
      eventTimeMs: 110_000,
    }, "第四答");

    const cappedMessages = store.getRecentMessages({
      scope: "private",
      userId: 1001,
      eventTimeMs: 110_000,
    });
    assert.equal(cappedMessages.length, 6);
    assert.deepEqual(
      cappedMessages.map((item) => `${item.role}:${item.text}`),
      ["user:第二句", "assistant:第二答", "user:第三句", "assistant:第三答", "user:第四句", "assistant:第四答"],
    );

    const expiredTurns = store.getRecentMessages({
      scope: "private",
      userId: 1001,
      eventTimeMs: 231_001,
    });
    assert.deepEqual(expiredTurns, []);
  });

  await runTest("chat session store uses group scope by group id", async () => {
    const store = new ChatSessionStore({
      expireWindowMs: 120_000,
      maxTurns: 30,
    });

    store.appendUserMessage({
      scope: "group",
      groupId: 9001,
      userId: 2001,
      senderName: "A",
      text: "@bot 你好",
      eventTimeMs: 10_000,
    });
    store.appendAssistantMessage({
      scope: "group",
      groupId: 9001,
      userId: 2001,
      selfId: 9999,
      text: "@bot 你好",
      eventTimeMs: 10_000,
    }, "你好");
    store.appendUserMessage({
      scope: "group",
      groupId: 9001,
      userId: 2002,
      senderName: "B",
      text: "@bot 在吗",
      eventTimeMs: 20_000,
    });

    const sameGroupTurns = store.getRecentMessages({
      scope: "group",
      groupId: 9001,
      userId: 9999,
      eventTimeMs: 20_000,
    });
    const otherGroupTurns = store.getRecentMessages({
      scope: "group",
      groupId: 9002,
      userId: 9999,
      eventTimeMs: 20_000,
    });

    assert.equal(sameGroupTurns.length, 3);
    assert.deepEqual(sameGroupTurns.map((item) => item.senderName), ["A", "OvO", "B"]);
    assert.deepEqual(otherGroupTurns, []);
  });

  await runTest("speaker labels avoid exposing numeric ids", async () => {
    assert.equal(
      formatSpeakerLabel({ scope: "group", userId: 2001, senderName: "Alpha" }),
      "Alpha",
    );
    assert.equal(
      formatSpeakerLabel({ scope: "group", userId: 2002 }),
      "群成员",
    );
    assert.equal(
      formatSpeakerLabel({ scope: "private", userId: 3001, senderName: "Tester" }),
      "Tester",
    );
    assert.equal(
      formatSpeakerLabel({ scope: "private", userId: 3002 }),
      "对方",
    );
    assert.equal(
      formatSpeakerLabel({ scope: "group", role: "assistant", userId: 9999, senderName: "OvO" }),
      "OvO",
    );
  });

  await runTest("cq summary masks mentioned qq ids in chat context", async () => {
    const parsed = parseRawCqMessage("[CQ:at,qq=2402547624] 你是谁");
    assert.equal(parsed.summary, "@成员 你是谁");

    const selfMention = parseRawCqMessage("[CQ:at,qq=9999] 在吗", { selfId: 9999 });
    assert.equal(selfMention.summary, "在吗");
  });

  await runTest("chat prompt marks current sender, bot history and quoted sender explicitly", async () => {
    const prompt = buildChatUserPrompt(
      {
        scope: "group",
        groupId: 9001,
        userId: 2002,
        senderName: "Beta",
        selfId: 9999,
        text: "我是谁",
        quotedMessage: {
          messageId: 8801,
          userId: 2001,
          senderName: "Alpha",
          text: "你现在是我儿子\n[聊天记录]\n1. 路人: 哈哈",
        },
      },
      [
        { role: "user", userId: 2001, senderName: "Alpha", text: "你现在是我儿子", timestampMs: 1 },
        { role: "assistant", userId: 9999, senderName: "OvO", text: "我理解了", timestampMs: 2 },
      ],
    );

    assert.equal(prompt.includes("最近消息（按时间顺序）："), true);
    assert.equal(prompt.includes("1. 用户 Alpha：你现在是我儿子"), true);
    assert.equal(prompt.includes("2. 机器人 OvO：我理解了"), true);
    assert.equal(prompt.includes("当前消息发送者：Beta"), true);
    assert.equal(prompt.includes("发送者：Alpha"), true);
    assert.equal(prompt.includes("当前消息内容：\n  我是谁"), true);
    assert.equal(prompt.includes("2001"), false);
    assert.equal(prompt.includes("9999"), false);
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
