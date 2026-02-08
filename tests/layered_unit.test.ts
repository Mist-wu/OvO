import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseCommand } from "../src/napcat/commands/registry";
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
}

void main();
