import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseCommand } from "../src/napcat/commands/registry";
import { config } from "../src/config";
import { ChatMemoryManager, extractFactCandidates } from "../src/chat/memory";
import { resolveVisualInputs } from "../src/chat/media";
import { decideTrigger } from "../src/chat/trigger";
import { InMemorySessionStore, createSessionKey } from "../src/chat/session_store";
import {
  buildActionPayload,
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
import { ChatMemoryStore } from "../src/storage/chat_memory_store";
import { ConfigStore } from "../src/storage/config_store";

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

  await runTest("command registry keeps /问 as root and /帮助 as user", async () => {
    const askCommand = parseCommand("/问 你好");
    assert.ok(askCommand);
    assert.equal(askCommand?.definition.name, "ask");
    assert.equal(askCommand?.definition.access ?? "root", "root");

    const helpCommand = parseCommand("/帮助");
    assert.ok(helpCommand);
    assert.equal(helpCommand?.definition.name, "user_help");
    assert.equal(helpCommand?.definition.access, "user");
  });

  await runTest("chat trigger follows passive strategy", async () => {
    const privateDecision = decideTrigger(
      {
        scope: "private",
        userId: 1,
        text: "你好",
      },
      ["小o", "ovo"],
    );
    assert.equal(privateDecision.shouldReply, true);
    assert.equal(privateDecision.reason, "private_default");

    const groupDecision = decideTrigger(
      {
        scope: "group",
        userId: 2,
        groupId: 100,
        selfId: 999,
        text: "小o 在吗",
      },
      ["小o", "ovo"],
    );
    assert.equal(groupDecision.shouldReply, true);
    assert.equal(groupDecision.reason, "named_bot");

    const mentionDecision = decideTrigger(
      {
        scope: "group",
        userId: 2,
        groupId: 100,
        selfId: 999,
        text: "",
        segments: [{ type: "at", data: { qq: 999 } }],
      },
      ["小o", "ovo"],
    );
    assert.equal(mentionDecision.shouldReply, true);
    assert.equal(mentionDecision.reason, "mentioned");

    const notTriggered = decideTrigger(
      {
        scope: "group",
        userId: 2,
        groupId: 100,
        selfId: 999,
        text: "今天吃什么",
      },
      ["小o", "ovo"],
    );
    assert.equal(notTriggered.shouldReply, false);
    assert.equal(notTriggered.reason, "not_triggered");

    const privateImageOnly = decideTrigger(
      {
        scope: "private",
        userId: 5,
        text: "",
        segments: [
          {
            type: "image",
            data: {
              file: "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=",
            },
          },
        ],
      },
      ["小o", "ovo"],
    );
    assert.equal(privateImageOnly.shouldReply, true);
    assert.equal(privateImageOnly.reason, "private_default");
  });

  await runTest("resolve visual inputs supports data-uri gif", async () => {
    const visuals = await resolveVisualInputs([
      {
        type: "image",
        data: {
          file: "data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=",
        },
      },
    ]);

    assert.equal(visuals.length, 1);
    assert.equal(visuals[0].mimeType, "image/gif");
    assert.equal(visuals[0].dataBase64.length > 0, true);
  });

  await runTest("in-memory session store keeps sliding window", async () => {
    const store = new InMemorySessionStore(2);
    const key = createSessionKey({
      scope: "private",
      userId: 7,
      text: "hi",
    });

    store.append(key, { role: "user", text: "a", ts: 1 });
    store.append(key, { role: "assistant", text: "b", ts: 2 });
    store.append(key, { role: "user", text: "c", ts: 3 });

    const history = store.get(key);
    assert.equal(history.length, 2);
    assert.equal(history[0].text, "b");
    assert.equal(history[1].text, "c");
  });

  await runTest("action helpers produce expected payloads", async () => {
    const message = [{ type: "text", data: { text: "hello" } }];

    const privateParams = createSendPrivateMsgParams(123, message);
    assert.deepEqual(privateParams, { user_id: 123, message });

    const groupParams = createSendGroupMsgParams(456, message);
    assert.deepEqual(groupParams, { group_id: 456, message });

    const getStatus = createGetStatusParams();
    assert.deepEqual(getStatus, {});

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
      groupEnabled: {},
      cooldownMs: 0,
    });

    assert.equal(store.isGroupEnabled(12345), false);
    assert.equal(store.getCooldownMs(), 777);

    const persisted = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      version?: number;
      groupEnabled?: Record<string, boolean>;
      cooldownMs?: number;
    };
    assert.equal(persisted.version, 1);
    assert.equal(persisted.groupEnabled?.["12345"], false);
    assert.equal(persisted.cooldownMs, 777);
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

  await runTest("chat memory fact extractor captures identity and preference", async () => {
    const facts = extractFactCandidates("我叫阿星，我喜欢拉面，我不喜欢香菜");
    assert.equal(facts.some((item) => item.category === "identity"), true);
    assert.equal(
      facts.some((item) => item.category === "preference" && item.content.includes("喜欢:拉面")),
      true,
    );
    assert.equal(
      facts.some((item) => item.category === "preference" && item.content.includes("不喜欢:香菜")),
      true,
    );
  });

  await runTest("chat memory store persists user facts and summaries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-chat-memory-"));
    const filePath = path.join(tmpDir, "chat_memory.json");

    const store = new ChatMemoryStore(filePath, {
      maxFactsPerUser: 10,
      maxSummariesPerSession: 10,
    });
    store.touchUser(10001, "测试用户");
    store.rememberFact(10001, "preference", "喜欢:咖啡");
    store.appendSessionSummary("p:10001", "用户提到喜欢咖啡", 4);

    const reloaded = new ChatMemoryStore(filePath, {
      maxFactsPerUser: 10,
      maxSummariesPerSession: 10,
    });
    const facts = reloaded.getUserFacts(10001, 5);
    const summaries = reloaded.getSessionSummaries("p:10001", 5);

    assert.equal(facts.length, 1);
    assert.equal(facts[0].content, "喜欢:咖啡");
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].summary, "用户提到喜欢咖啡");
  });

  await runTest("chat memory manager archives old session messages", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-chat-manager-"));
    const filePath = path.join(tmpDir, "chat_memory.json");

    const previous = {
      memoryEnabled: config.chat.memoryEnabled,
      memoryPath: config.chat.memoryPath,
      memoryContextFactCount: config.chat.memoryContextFactCount,
      summaryContextCount: config.chat.summaryContextCount,
      summaryArchiveTriggerMessages: config.chat.summaryArchiveTriggerMessages,
      summaryArchiveChunkMessages: config.chat.summaryArchiveChunkMessages,
      summaryArchiveKeepLatestMessages: config.chat.summaryArchiveKeepLatestMessages,
      summaryArchiveMaxPerSession: config.chat.summaryArchiveMaxPerSession,
      memoryMaxFactsPerUser: config.chat.memoryMaxFactsPerUser,
    };

    Object.assign(config.chat, {
      memoryEnabled: true,
      memoryPath: filePath,
      memoryContextFactCount: 5,
      summaryContextCount: 3,
      summaryArchiveTriggerMessages: 4,
      summaryArchiveChunkMessages: 2,
      summaryArchiveKeepLatestMessages: 2,
      summaryArchiveMaxPerSession: 10,
      memoryMaxFactsPerUser: 20,
    });

    try {
      const sessions = new InMemorySessionStore(20);
      const manager = new ChatMemoryManager(sessions);
      const sessionKey = "p:30001";

      sessions.append(sessionKey, { role: "user", text: "第一句", ts: 1 });
      sessions.append(sessionKey, { role: "assistant", text: "第一句回复", ts: 2 });
      sessions.append(sessionKey, { role: "user", text: "第二句", ts: 3 });
      sessions.append(sessionKey, { role: "assistant", text: "第二句回复", ts: 4 });
      sessions.append(sessionKey, { role: "user", text: "第三句", ts: 5 });
      sessions.append(sessionKey, { role: "assistant", text: "第三句回复", ts: 6 });

      manager.recordTurn({
        event: {
          scope: "private",
          userId: 30001,
          senderName: "阿星",
          text: "我喜欢拉面",
        },
        sessionKey,
        userText: "我喜欢拉面",
      });

      const remaining = sessions.get(sessionKey);
      assert.equal(remaining.length, 4);

      const context = manager.getContext(
        {
          scope: "private",
          userId: 30001,
          text: "继续聊",
        },
        sessionKey,
      );
      assert.equal(context.longTermFacts.some((item) => item.includes("喜欢:拉面")), true);
      assert.equal(context.archivedSummaries.length >= 1, true);
    } finally {
      Object.assign(config.chat, previous);
    }
  });
}

void main();
