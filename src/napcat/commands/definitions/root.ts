import { logger } from "../../../utils/logger";
import { config } from "../../../config";
import { askGemini } from "../../../llm";
import { compactSessionMemoryWithLlm, compactUserMemoryWithLlm } from "../../../chat/memory_compactor";
import { runtimeSkills } from "../../../skills/runtime";
import { configStore } from "../../../storage/config_store";
import type { CommandDefinition } from "../types";

type EmptyPayload = Record<string, never>;
type HelpScope = "root" | "user";
type HelpTextProvider = (scope: HelpScope) => string;

const emptyPayload: EmptyPayload = {};

function defineCommand<Payload>(
  definition: CommandDefinition<Payload>,
): CommandDefinition<unknown> {
  return definition as CommandDefinition<unknown>;
}

function splitParts(message: string): string[] {
  return message.trim().split(/\s+/);
}

function parseNumber(value: string, allowZero = false): number | null {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) return null;
  if (allowZero) {
    if (parsed < 0) return null;
    return parsed;
  }
  return parsed > 0 ? parsed : null;
}

export function createRootCommands(getHelpText: HelpTextProvider): CommandDefinition<unknown>[] {
  return [
    defineCommand({
      name: "ping",
      help: "/ping",
      parse(message) {
        return message.trim() === "/ping" ? emptyPayload : null;
      },
      async execute(context) {
        await context.sendText("pong");
      },
    }),
    defineCommand({
      name: "echo",
      help: "/echo <text>",
      parse(message) {
        const trimmed = message.trim();
        if (!trimmed.startsWith("/echo ")) return null;
        return { text: trimmed.slice(6).trim() };
      },
      async execute(context, payload) {
        const text = (payload as { text?: string }).text || "(empty)";
        await context.sendText(text);
      },
    }),
    defineCommand({
      name: "ask",
      help: "/问 <问题>",
      parse(message) {
        const matched = message.trim().match(/^\/问(?:\s+(.+))?$/);
        if (!matched) return null;
        return { prompt: matched[1]?.trim() || "" };
      },
      async execute(context, payload) {
        const prompt = (payload as { prompt?: string }).prompt || "";
        if (!prompt) {
          await context.sendText("用法：/问 <问题>");
          return;
        }

        try {
          const answer = await askGemini(prompt);
          await context.sendText(answer);
        } catch (error) {
          logger.warn("[llm] /问 失败:", error);
          const message = error instanceof Error ? error.message : "";
          if (message.includes("GEMINI_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("问答失败，请稍后重试");
        }
      },
    }),
    defineCommand({
      name: "memory_compact",
      help: "/记忆压缩 <user 用户ID | session 会话Key>",
      cooldownExempt: true,
      parse(message) {
        const parts = splitParts(message);
        const command = parts[0];
        if (command !== "/记忆压缩" && command !== "/memory_compact") return null;
        if (parts.length < 3) return { kind: "invalid" as const };
        const kind = parts[1]?.toLowerCase();
        if (kind === "user") {
          const userId = parseNumber(parts[2]);
          if (userId === null) return { kind: "invalid" as const };
          return { kind: "user" as const, userId };
        }
        if (kind === "session") {
          const sessionKey = parts.slice(2).join(" ").trim();
          if (!sessionKey) return { kind: "invalid" as const };
          return { kind: "session" as const, sessionKey };
        }
        return { kind: "invalid" as const };
      },
      async execute(context, payload) {
        const parsed = payload as
          | { kind: "invalid" }
          | { kind: "user"; userId: number }
          | { kind: "session"; sessionKey: string };
        if (parsed.kind === "invalid") {
          await context.sendText("用法：/记忆压缩 <user 用户ID | session 会话Key>");
          return;
        }

        await context.sendText(
          parsed.kind === "user"
            ? `开始压缩用户记忆 user=${parsed.userId}（LLM 手动压缩）...`
            : `开始压缩会话摘要 session=${parsed.sessionKey}（LLM 手动压缩）...`,
        );

        try {
          const result =
            parsed.kind === "user"
              ? await compactUserMemoryWithLlm(parsed.userId)
              : await compactSessionMemoryWithLlm(parsed.sessionKey);
          if (result.target === "user") {
            await context.sendText(
              `用户记忆压缩完成 user=${result.userId} facts ${result.before} -> ${result.after}` +
              (result.note ? `\nnote=${result.note}` : ""),
            );
            return;
          }
          await context.sendText(
            `会话摘要压缩完成 session=${result.sessionKey} summaries ${result.before} -> ${result.after}` +
            (result.note ? `\nnote=${result.note}` : ""),
          );
        } catch (error) {
          logger.warn("[memory] /记忆压缩 失败:", error);
          const message = error instanceof Error ? error.message : String(error);
          await context.sendText(`记忆压缩失败：${message}`);
        }
      },
    }),
    defineCommand({
      name: "help",
      help: "/help",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/help" ? emptyPayload : null;
      },
      async execute(context) {
        await context.sendText(getHelpText("root"));
      },
    }),
    defineCommand({
      name: "status",
      help: "/status",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/status" ? emptyPayload : null;
      },
      async execute(context) {
        const runtime = context.client.getRuntimeStatus();
        const lastPongAgeMs = Math.max(0, Date.now() - runtime.lastPongAt);
        await context.sendText(
          `connected=${runtime.connected} reconnecting=${runtime.reconnecting} ` +
          `inflight=${runtime.inFlightActions} queued=${runtime.queuedActions} ` +
          `pending=${runtime.pendingActions} pong_age_ms=${lastPongAgeMs} ` +
          `queue_overflow_count=${runtime.queueOverflowCount} ` +
          `retry_count=${runtime.retryCount} ` +
          `rate_limit_wait_ms_total=${runtime.rateLimitWaitMsTotal}`,
        );
      },
    }),
    defineCommand({
      name: "config",
      help: "/config",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/config" ? emptyPayload : null;
      },
      async execute(context) {
        const snapshot = configStore.snapshot;
        const skillCount = runtimeSkills.registry.list().length;
        const rootUserId =
          typeof config.permissions.rootUserId === "number"
            ? String(config.permissions.rootUserId)
            : "(unset)";
        await context.sendText(
          `rootUserId=${rootUserId} cooldownMs=${snapshot.cooldownMs} ` +
          `groupReplyMode=@only proactiveGroupReply=false ` +
          `autoApproveGroup=${config.requests.autoApproveGroup} ` +
          `autoApproveFriend=${config.requests.autoApproveFriend} ` +
          `skillsLoaded=${skillCount}`,
        );
      },
    }),
    defineCommand({
      name: "cooldown_get",
      help: "/cooldown [ms]",
      parse(message) {
        const parts = splitParts(message);
        return parts[0] === "/cooldown" && parts.length === 1 ? emptyPayload : null;
      },
      async execute(context) {
        await context.sendText(`当前冷却时间 ${configStore.getCooldownMs()}ms`);
      },
    }),
    defineCommand({
      name: "cooldown_set",
      cooldownExempt: true,
      parse(message) {
        const parts = splitParts(message);
        if (parts[0] !== "/cooldown" || parts.length !== 2) return null;

        const ms = parseNumber(parts[1], true);
        if (ms === null) return null;
        return { ms };
      },
      async execute(context, payload) {
        const ms = (payload as { ms: number }).ms;
        configStore.setCooldownMs(ms);
        await context.sendText(`已设置冷却时间 ${ms}ms`);
      },
    }),
  ];
}
