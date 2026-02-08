import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

import { parseCommand } from "../src/napcat/commands/registry";
import {
  isMessageEvent,
  isMetaEvent,
  isNoticeEvent,
  isRequestEvent,
  type OneBotEvent,
} from "../src/napcat/commands/types";
import { ExternalCallError, runExternalCall } from "../src/utils/external_call";

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
