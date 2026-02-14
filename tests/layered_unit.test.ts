import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { parseCommand } from "../src/napcat/commands/registry";
import { config } from "../src/config";
import { ChatAgentLoop } from "../src/chat/agent_loop";
import { ChatMemoryManager, extractFactCandidates } from "../src/chat/memory";
import { resolveVisualInputs } from "../src/chat/media";
import type { ChatOrchestrator, PreparedChatReply } from "../src/chat/orchestrator";
import { decideTrigger } from "../src/chat/trigger";
import { buildPrompt } from "../src/chat/context_builder";
import { detectMathExpression, detectSearchQuery, detectWeatherLocation } from "../src/chat/tool_router";
import { decideProactiveActions } from "../src/chat/proactive";
import { InMemorySessionStore, createSessionKey } from "../src/chat/session_store";
import { ChatStateEngine } from "../src/chat/state_engine";
import { calculateExpressionSummary, evaluateExpression } from "../src/utils/calc";
import { detectFxIntent } from "../src/utils/fx";
import { detectTimeIntent, getTimeSummary } from "../src/utils/time";
import { createChatContextPipeline } from "../src/chat/context_pipeline";
import { SkillLoader } from "../src/skills/runtime/loader";
import { SkillRegistry } from "../src/skills/runtime/registry";
import { SkillExecutor } from "../src/skills/runtime/executor";
import {
  buildActionPayload,
  createGetStatusParams,
  createSendGroupMsgParams,
  createSendPrivateMsgParams,
  createSetFriendAddRequestParams,
  createSetGroupAddRequestParams,
} from "../src/napcat/actions";
import { calculateActionRetryDelayMs } from "../src/napcat/client";
import type { NapcatClient } from "../src/napcat/client";
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
import { configStore } from "../src/storage/config_store";
import { cooldownMiddleware } from "../src/napcat/commands/middleware";

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
    assert.equal(notTriggered.priority, "low");
    assert.equal(notTriggered.waitMs, 0);

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
    assert.equal(privateImageOnly.priority, "high");
    assert.equal(privateImageOnly.waitMs > 0, true);
  });

  await runTest("chat trigger computes willingness and priority in group", async () => {
    const highIntent = decideTrigger(
      {
        scope: "group",
        groupId: 123,
        userId: 10086,
        selfId: 999,
        text: "有人知道这个bot报错怎么修吗？我代码一直炸",
      },
      ["小o", "ovo"],
    );
    assert.equal(highIntent.shouldReply, true);
    assert.equal(highIntent.reason, "group_willing");
    assert.equal(highIntent.priority === "high" || highIntent.priority === "normal", true);
    assert.equal(highIntent.willingness >= 0.62, true);
    assert.equal(highIntent.waitMs > 0, true);

    const lowIntent = decideTrigger(
      {
        scope: "group",
        groupId: 123,
        userId: 20001,
        selfId: 999,
        text: "哈哈",
      },
      ["小o", "ovo"],
    );
    assert.equal(lowIntent.shouldReply, false);
    assert.equal(lowIntent.reason, "not_triggered");
    assert.equal(lowIntent.willingness < 0.62, true);
  });

  await runTest("chat agent loop cancels delayed turn on follow-up", async () => {
    const preparedEvents: string[] = [];
    const committedEvents: string[] = [];
    const sentTexts: string[] = [];

    const orchestrator: ChatOrchestrator = {
      decide(event) {
        return {
          shouldReply: true,
          reason: "private_default",
          priority: "high",
          waitMs: event.text === "first" ? 90 : 0,
          willingness: 0.95,
        };
      },
      async prepare(event): Promise<PreparedChatReply> {
        preparedEvents.push(event.text);
        return {
          event,
          sessionKey: `p:${event.userId}`,
          normalizedUserText: event.text,
          reply: {
            text: `reply:${event.text}`,
            from: "llm",
          },
        };
      },
      commit(prepared) {
        committedEvents.push(prepared.event.text);
      },
      async handle() {
        return null;
      },
    };

    const loop = new ChatAgentLoop(orchestrator);
    const client = {
      sendPrivateText: async (_userId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
      sendGroupText: async (_groupId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
    } as unknown as NapcatClient;

    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7001,
      text: "first",
    });
    await delay(20);
    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7001,
      text: "second",
    });
    await delay(220);

    assert.deepEqual(preparedEvents, ["second"]);
    assert.deepEqual(committedEvents, ["second"]);
    assert.deepEqual(sentTexts, ["reply:second"]);
  });

  await runTest("chat agent loop skips stale running reply after interruption", async () => {
    const preparedEvents: string[] = [];
    const committedEvents: string[] = [];
    const sentTexts: string[] = [];

    const orchestrator: ChatOrchestrator = {
      decide() {
        return {
          shouldReply: true,
          reason: "private_default",
          priority: "high",
          waitMs: 0,
          willingness: 0.95,
        };
      },
      async prepare(event): Promise<PreparedChatReply> {
        preparedEvents.push(event.text);
        if (event.text === "first") {
          await delay(90);
        }
        return {
          event,
          sessionKey: `p:${event.userId}`,
          normalizedUserText: event.text,
          reply: {
            text: `reply:${event.text}`,
            from: "llm",
          },
        };
      },
      commit(prepared) {
        committedEvents.push(prepared.event.text);
      },
      async handle() {
        return null;
      },
    };

    const loop = new ChatAgentLoop(orchestrator);
    const client = {
      sendPrivateText: async (_userId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
      sendGroupText: async (_groupId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
    } as unknown as NapcatClient;

    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7002,
      text: "first",
    });
    await delay(10);
    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7002,
      text: "second",
    });
    await delay(260);

    assert.deepEqual(preparedEvents, ["first", "second"]);
    assert.deepEqual(committedEvents, ["second"]);
    assert.deepEqual(sentTexts, ["reply:second"]);
  });

  await runTest("chat agent loop emits observable events and runtime snapshot", async () => {
    const observed: string[] = [];
    const orchestrator: ChatOrchestrator = {
      decide() {
        return {
          shouldReply: true,
          reason: "private_default",
          priority: "high",
          waitMs: 0,
          willingness: 0.95,
        };
      },
      async prepare(event): Promise<PreparedChatReply> {
        return {
          event,
          sessionKey: `p:${event.userId}`,
          normalizedUserText: event.text,
          reply: {
            text: `ok:${event.text}`,
            from: "tool",
          },
        };
      },
      commit() { },
      async handle() {
        return null;
      },
    };

    const loop = new ChatAgentLoop(orchestrator);
    const unsubscribe = loop.subscribe((event) => {
      observed.push(event.type);
    });

    const client = {
      sendPrivateText: async () => ({
        status: "ok",
        retcode: 0,
      }),
      sendGroupText: async () => ({
        status: "ok",
        retcode: 0,
      }),
    } as unknown as NapcatClient;

    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7010,
      text: "hello",
    });
    await delay(120);
    unsubscribe();

    const snapshot = loop.getRuntimeSnapshot();
    assert.equal(snapshot.queueSize, 0);
    assert.equal(snapshot.pumping, false);
    assert.equal(snapshot.pendingProactiveGroups, 0);
    assert.equal(snapshot.activeReplySessions, 0);
    assert.equal(observed.includes("incoming"), true);
    assert.equal(observed.includes("decision"), true);
    assert.equal(observed.includes("turn_enqueued"), true);
    assert.equal(observed.includes("turn_started"), true);
    assert.equal(observed.includes("turn_sent"), true);
    assert.equal(observed.includes("turn_completed"), true);
    assert.equal(observed.includes("queue_idle"), true);
  });

  await runTest("chat agent loop requests hard interrupt and aborts running turn", async () => {
    const events: string[] = [];
    const droppedReasons: string[] = [];
    const sentTexts: string[] = [];

    const orchestrator: ChatOrchestrator = {
      decide() {
        return {
          shouldReply: true,
          reason: "private_default",
          priority: "high",
          waitMs: 0,
          willingness: 0.95,
        };
      },
      async prepare(event, _decision, options): Promise<PreparedChatReply> {
        if (event.text === "first") {
          await new Promise<void>((resolve, reject) => {
            const onAbort = () => {
              const error = new Error("aborted by next turn");
              error.name = "AbortError";
              reject(error);
            };
            if (options?.signal?.aborted) {
              onAbort();
              return;
            }
            options?.signal?.addEventListener("abort", onAbort, { once: true });
            setTimeout(() => {
              options?.signal?.removeEventListener("abort", onAbort);
              resolve();
            }, 150);
          });
        }
        return {
          event,
          sessionKey: `p:${event.userId}`,
          normalizedUserText: event.text,
          reply: {
            text: `reply:${event.text}`,
            from: "llm",
          },
        };
      },
      commit() { },
      async handle() {
        return null;
      },
    };

    const loop = new ChatAgentLoop(orchestrator);
    const unsubscribe = loop.subscribe((event) => {
      events.push(event.type);
      if (event.type === "turn_dropped") {
        droppedReasons.push(event.reason);
      }
    });
    const client = {
      sendPrivateText: async (_userId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
      sendGroupText: async (_groupId: number, text: string) => {
        sentTexts.push(text);
        return {
          status: "ok",
          retcode: 0,
        };
      },
    } as unknown as NapcatClient;

    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7011,
      text: "first",
    });
    await delay(20);
    await loop.onIncomingMessage(client, {
      scope: "private",
      userId: 7011,
      text: "second",
    });
    await delay(260);
    unsubscribe();

    assert.equal(events.includes("turn_interrupt_requested"), true);
    assert.equal(droppedReasons.includes("aborted"), true);
    assert.deepEqual(sentTexts, ["reply:second"]);
  });

  await runTest("tool router detects weather location and search query", async () => {
    assert.equal(detectWeatherLocation("北京天气怎么样"), "北京");
    assert.equal(detectWeatherLocation("查 上海 天气"), "上海");
    assert.equal(detectWeatherLocation("今天天气真好"), undefined);

    assert.equal(detectSearchQuery("帮我搜一下 OpenAI GPT-5 发布说明"), "OpenAI GPT-5 发布说明");
    assert.equal(detectSearchQuery("量子纠缠是什么？"), "量子纠缠是什么");
    assert.equal(detectSearchQuery("/天气 北京"), undefined);
    assert.equal(detectMathExpression("计算 (1+2)*3"), "(1+2)*3");
    assert.equal(detectMathExpression("今天心情不错"), undefined);
  });

  await runTest("time and fx intent detectors parse common expressions", async () => {
    const time = detectTimeIntent("东京现在几点");
    assert.ok(time);
    assert.equal(time?.timezone, "Asia/Tokyo");

    const fx = detectFxIntent("100 美元换成人民币");
    assert.ok(fx);
    assert.equal(fx?.from, "USD");
    assert.equal(fx?.to, "CNY");
    assert.equal(fx?.amount, 100);
  });

  await runTest("calc utility evaluates expression safely", async () => {
    assert.equal(evaluateExpression("(1+2)*3"), 9);
    assert.equal(calculateExpressionSummary("3+4*2"), "计算结果：3+4*2 = 11");
    assert.equal(calculateExpressionSummary("3/0").startsWith("计算失败"), true);
  });

  await runTest("time utility formats summary text", async () => {
    const summary = getTimeSummary({
      timezone: "Asia/Shanghai",
      label: "北京时间",
    });
    assert.equal(summary.includes("北京时间 当前时间："), true);
  });

  await runTest("skill loader and registry parse SKILL metadata", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-skills-"));
    const weatherDir = path.join(tmpDir, "weather");
    const searchDir = path.join(tmpDir, "search");
    fs.mkdirSync(weatherDir, { recursive: true });
    fs.mkdirSync(searchDir, { recursive: true });

    fs.writeFileSync(
      path.join(weatherDir, "SKILL.md"),
      [
        "---",
        "name: weather",
        "description: weather skill",
        "capability: weather",
        "mode: direct",
        "---",
        "",
        "# Weather",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(searchDir, "SKILL.md"),
      [
        "---",
        "name: search",
        "description: search skill",
        "capability: search",
        "mode: context",
        "---",
        "",
        "# Search",
      ].join("\n"),
      "utf8",
    );

    const loader = new SkillLoader(tmpDir);
    const loaded = loader.loadAll();
    assert.equal(loaded.length, 2);

    const registry = new SkillRegistry(loader);
    const weather = registry.findFirstByCapability("weather");
    const search = registry.findFirstByCapability("search");
    assert.equal(weather?.name, "weather");
    assert.equal(search?.name, "search");
  });

  await runTest("skill executor resolves search context and missing skill", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ovo-skill-exec-"));
    const searchDir = path.join(tmpDir, "search");
    fs.mkdirSync(searchDir, { recursive: true });
    fs.writeFileSync(
      path.join(searchDir, "SKILL.md"),
      [
        "---",
        "name: search",
        "description: search skill",
        "capability: search",
        "mode: context",
        "---",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(tmpDir, "time"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "time", "SKILL.md"),
      [
        "---",
        "name: time",
        "description: time skill",
        "capability: time",
        "mode: direct",
        "---",
      ].join("\n"),
      "utf8",
    );
    fs.mkdirSync(path.join(tmpDir, "calc"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "calc", "SKILL.md"),
      [
        "---",
        "name: calc",
        "description: calc skill",
        "capability: calc",
        "mode: direct",
        "---",
      ].join("\n"),
      "utf8",
    );

    const loader = new SkillLoader(tmpDir);
    const registry = new SkillRegistry(loader);
    const executor = new SkillExecutor(registry);

    const searchResult = await executor.execute({
      capability: "search",
      query: "量子纠缠是什么",
    });
    assert.equal(searchResult.handled, true);
    if (searchResult.handled) {
      assert.equal(searchResult.mode, "context");
      assert.equal(searchResult.text.includes("量子纠缠是什么"), true);
    }

    const timeResult = await executor.execute({
      capability: "time",
      timezone: "Asia/Shanghai",
      label: "北京时间",
      query: "北京时间",
    });
    assert.equal(timeResult.handled, true);
    if (timeResult.handled) {
      assert.equal(timeResult.mode, "direct");
      assert.equal(timeResult.text.includes("当前时间"), true);
    }

    const calcResult = await executor.execute({
      capability: "calc",
      expression: "1+2*3",
      query: "计算 1+2*3",
    });
    assert.equal(calcResult.handled, true);
    if (calcResult.handled) {
      assert.equal(calcResult.text.includes("= 7"), true);
    }

    const weatherResult = await executor.execute({
      capability: "weather",
      location: "北京",
      query: "北京天气",
    });
    assert.equal(weatherResult.handled, false);
    if (!weatherResult.handled) {
      assert.equal(weatherResult.reason, "skill_not_found");
    }
  });

  await runTest("context builder includes event time and tool context", async () => {
    const prompt = buildPrompt({
      persona: {
        name: "小o",
        style: "test",
        slang: ["确实"],
        doNot: ["编造"],
        replyLength: "short",
      },
      history: [{ role: "user", text: "你好", ts: 1 }],
      archivedSummaries: [],
      longTermFacts: [],
      userText: "今天北京天气咋样",
      scope: "private",
      mediaCount: 0,
      eventTimeMs: 1739145600000,
      stateContext: {
        emotionLabel: "curious",
        emotionScore: 0.3,
        userProfileText: "称呼:阿星 | 累计消息:10 | 互动层级:中互动",
        relationshipText: "当前互动亲和度:中性",
        groupTopicText: "TypeScript / NapCat",
        groupActivityText: "中活跃（近10分钟消息12条）",
      },
      toolContext: "工具结果（网页搜索）：\n搜索词：北京天气",
    });

    assert.equal(prompt.includes("当前消息时间（NapCat事件时间）："), true);
    assert.equal(prompt.includes("工具调用上下文："), true);
    assert.equal(prompt.includes("搜索词：北京天气"), true);
    assert.equal(prompt.includes("当前情感：curious"), true);
    assert.equal(prompt.includes("目标用户信息："), true);
  });

  await runTest("chat context pipeline applies transform then convert", async () => {
    const pipeline = createChatContextPipeline({
      transformers: [
        async (input) => ({
          ...input,
          userText: `${input.userText} transformed`,
          longTermFacts: [...input.longTermFacts, "新增事实"],
        }),
      ],
      converter: (input) =>
        JSON.stringify({
          userText: input.userText,
          factCount: input.longTermFacts.length,
        }),
    });

    const result = await pipeline.run({
      persona: {
        name: "小o",
        style: "test",
        slang: [],
        doNot: [],
        replyLength: "short",
      },
      history: [],
      archivedSummaries: [],
      longTermFacts: ["已知事实"],
      userText: "hello",
      scope: "private",
      mediaCount: 0,
    });

    const parsed = JSON.parse(result) as {
      userText: string;
      factCount: number;
    };
    assert.equal(parsed.userText, "hello transformed");
    assert.equal(parsed.factCount, 2);
  });

  await runTest("chat state engine provides prompt context and trigger hints", async () => {
    const engine = new ChatStateEngine();
    engine.recordIncoming({
      scope: "group",
      groupId: 321,
      userId: 1001,
      senderName: "阿星",
      text: "我最近在研究 TypeScript 项目架构，感觉很上头！",
    });
    engine.recordIncoming({
      scope: "group",
      groupId: 321,
      userId: 1002,
      senderName: "阿月",
      text: "NapCat 的事件字段要按文档来，别硬写",
    });
    engine.recordIncoming({
      scope: "group",
      groupId: 321,
      userId: 1001,
      senderName: "阿星",
      text: "这个话题我还想继续聊下去",
    });
    engine.recordReply(
      {
        scope: "group",
        groupId: 321,
        userId: 1001,
        senderName: "阿星",
        text: "继续",
      },
      "继续聊",
    );

    const context = engine.getPromptState({
      scope: "group",
      groupId: 321,
      userId: 1001,
      senderName: "阿星",
      text: "TypeScript 这块怎么拆层？",
    });
    assert.equal(context.userProfileText.includes("阿星"), true);
    assert.equal(context.groupTopicText !== "暂无稳定话题", true);

    const hints = engine.getTriggerHints({
      scope: "group",
      groupId: 321,
      userId: 1001,
      text: "TypeScript 分层实践有推荐吗？",
    });
    assert.equal(Number.isFinite(hints.userAffinityBoost), true);
    assert.equal(hints.topicRelevanceBoost >= 0, true);
  });

  await runTest("chat state engine prunes stale runtime state by ttl", async () => {
    const base = Date.now();
    const engine = new ChatStateEngine({
      userTtlMs: 30,
      groupTtlMs: 30,
      sessionTtlMs: 30,
      userMax: 100,
      groupMax: 100,
      sessionMax: 100,
      pruneIntervalMs: 1,
    });

    engine.recordIncoming({
      scope: "group",
      groupId: 9001,
      userId: 5001,
      text: "早期消息",
      eventTimeMs: base,
    });

    await delay(40);

    engine.recordIncoming({
      scope: "private",
      userId: 5002,
      text: "新消息",
      eventTimeMs: Date.now(),
    });

    const stats = engine.getRuntimeStats();
    assert.equal(stats.users, 1);
    assert.equal(stats.groups, 0);
    assert.equal(stats.sessions, 1);
  });

  await runTest("chat state engine caps runtime state size", async () => {
    const base = Date.now();
    const engine = new ChatStateEngine({
      userTtlMs: 60 * 60 * 1000,
      groupTtlMs: 60 * 60 * 1000,
      sessionTtlMs: 60 * 60 * 1000,
      userMax: 2,
      groupMax: 1,
      sessionMax: 2,
      pruneIntervalMs: 1,
    });

    engine.recordIncoming({
      scope: "private",
      userId: 6001,
      text: "u1",
      eventTimeMs: base + 1,
    });
    engine.recordIncoming({
      scope: "group",
      groupId: 9101,
      userId: 6002,
      text: "u2-g1",
      eventTimeMs: base + 2,
    });
    engine.recordIncoming({
      scope: "group",
      groupId: 9102,
      userId: 6003,
      text: "u3-g2",
      eventTimeMs: base + 3,
    });

    const stats = engine.getRuntimeStats();
    assert.equal(stats.users, 2);
    assert.equal(stats.groups, 1);
    assert.equal(stats.sessions, 2);
  });

  await runTest("proactive scheduler selects cold-start and topic continuation", async () => {
    const now = Date.now();
    const candidates = decideProactiveActions({
      snapshots: [
        {
          groupId: 101,
          topic: "暂无稳定话题",
          topicKeywords: [],
          messageCountRecent: 2,
          participantCountRecent: 1,
          lastMessageAt: now - 5 * 60 * 1000,
          lastProactiveAt: 0,
        },
        {
          groupId: 102,
          topic: "TypeScript / NapCat",
          topicKeywords: ["typescript", "napcat"],
          messageCountRecent: 20,
          participantCountRecent: 6,
          lastMessageAt: now - 2 * 60 * 1000,
          lastProactiveAt: 0,
        },
      ],
      now,
      enabledGroups: new Set([101, 102]),
      idleMs: 4 * 60 * 1000,
      continueIdleMs: 60 * 1000,
      minGapMs: 120 * 1000,
      bubbleIntervalMs: 20 * 60 * 1000,
      minRecentMessages: 6,
      maxPerTick: 2,
    });

    assert.equal(candidates.length, 2);
    assert.equal(candidates[0].reason, "cold_start_breaker");
    assert.equal(candidates[1].reason, "topic_continuation");
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

  await runTest("cooldown middleware prunes ttl and caps keys", async () => {
    const previous = {
      cooldownMs: configStore.getCooldownMs(),
      cooldownMaxKeys: config.permissions.cooldownMaxKeys,
      cooldownPruneIntervalMs: config.permissions.cooldownPruneIntervalMs,
      cooldownEntryTtlMs: config.permissions.cooldownEntryTtlMs,
    };

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
      } as unknown as Parameters<typeof cooldownMiddleware>[0];

      await cooldownMiddleware(context, async () => {
        executed += 1;
      });
    };

    try {
      configStore.setCooldownMs(0);
      await runCooldown(99901);
      executed = 0;
      notifications.length = 0;

      configStore.setCooldownMs(1000);
      config.permissions.cooldownMaxKeys = 2;
      config.permissions.cooldownPruneIntervalMs = 1;
      config.permissions.cooldownEntryTtlMs = 60 * 60 * 1000;

      await runCooldown(9101);
      await runCooldown(9101);
      assert.equal(executed, 1);
      assert.equal(notifications.some((item) => item.includes("冷却中")), true);

      await runCooldown(9102);
      await runCooldown(9103);
      await runCooldown(9101);
      assert.equal(executed, 4);

      await runCooldown(9103);
      assert.equal(executed, 4);

      config.permissions.cooldownMaxKeys = 100;
      config.permissions.cooldownPruneIntervalMs = 1;
      config.permissions.cooldownEntryTtlMs = 5;

      await runCooldown(9201, "echo");
      await delay(20);
      await runCooldown(9201, "echo");
      assert.equal(executed, 6);
    } finally {
      configStore.setCooldownMs(0);
      await runCooldown(99902);
      configStore.setCooldownMs(previous.cooldownMs);
      config.permissions.cooldownMaxKeys = previous.cooldownMaxKeys;
      config.permissions.cooldownPruneIntervalMs = previous.cooldownPruneIntervalMs;
      config.permissions.cooldownEntryTtlMs = previous.cooldownEntryTtlMs;
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

  await runTest("logger.emitRaw bypasses global LOG_LEVEL gate", async () => {
    // 动态导入 logger 以操作它的单例
    const { logger } = await import("../src/utils/logger");
    const originalLevel = logger.getLevel();
    const captured: Array<{ level: string; args: unknown[] }> = [];

    // 安装 spy transport
    logger.setTransport((level, _ts, args) => {
      captured.push({ level, args });
    });

    try {
      // 全局设为 warn —— 普通 info 应被过滤
      logger.setLevel("warn");
      logger.info("should_be_filtered");
      assert.equal(
        captured.some((item) => item.args.includes("should_be_filtered")),
        false,
        "logger.info should be filtered when level=warn",
      );

      // emitRaw 应绕过全局门控
      logger.emitRaw("info", "should_pass_through");
      assert.equal(
        captured.some((item) => item.args.includes("should_pass_through")),
        true,
        "logger.emitRaw should bypass global LOG_LEVEL gate",
      );

      // emitRaw("debug") 也应输出
      logger.emitRaw("debug", "debug_raw");
      assert.equal(
        captured.some((item) => item.level === "debug" && item.args.includes("debug_raw")),
        true,
        "logger.emitRaw('debug') should output even when level=warn",
      );

      // emitRaw("silent") 应被丢弃
      const countBefore = captured.length;
      logger.emitRaw("silent", "silent_msg");
      assert.equal(captured.length, countBefore, "emitRaw('silent') should discard");
    } finally {
      // 恢复原状
      logger.setLevel(originalLevel);
      // 恢复默认 transport（console）—— 直接重设为 console transport
      logger.setTransport((level, timestamp, args) => {
        const prefix = `${timestamp} [${level.toUpperCase()}]`;
        switch (level) {
          case "debug":
            console.debug(prefix, ...args);
            break;
          case "info":
            console.info(prefix, ...args);
            break;
          case "warn":
            console.warn(prefix, ...args);
            break;
          case "error":
            console.error(prefix, ...args);
            break;
        }
      });
    }
  });
}

void main();
