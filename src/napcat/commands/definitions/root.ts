import fs from "node:fs";
import { logger } from "../../../utils/logger";
import { config } from "../../../config";
import { activityStore, renderEmojiStatsCard, renderTalkStatsCard, type TopEmojiItem } from "../../../activity";
import { askGemini } from "../../../llm";
import { configStore } from "../../../storage/config_store";
import { buildMessage, face as faceSegment, image as imageSegment, text as textSegment, type MessageInput } from "../../message";
import type { CommandDefinition, CommandExecutionContext } from "../types";

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

function parseOptionalGroupIdFromPayload(payload: unknown): number | undefined {
  const groupId = (payload as { groupId?: number | undefined })?.groupId;
  return typeof groupId === "number" && Number.isFinite(groupId) ? groupId : undefined;
}

function resolveStatsGroupId(
  context: { groupId?: number; messageType?: string },
  payload: unknown,
): number | null {
  const payloadGroupId = parseOptionalGroupIdFromPayload(payload);
  if (typeof payloadGroupId === "number") return payloadGroupId;
  if (context.messageType === "group" && typeof context.groupId === "number") {
    return context.groupId;
  }
  return null;
}

async function sendContextImage(
  context: CommandExecutionContext,
  imageFile: string,
  caption?: string,
): Promise<void> {
  const message = caption
    ? buildMessage(imageSegment(imageFile), textSegment(`\n${caption}`))
    : buildMessage(imageSegment(imageFile));

  if (context.messageType === "group" && typeof context.groupId === "number") {
    await context.client.sendMessage({ groupId: context.groupId, message });
    return;
  }

  await context.client.sendMessage({ userId: context.userId, message });
}

async function sendContextTextMessage(
  context: CommandExecutionContext,
  text: string,
): Promise<void> {
  if (context.messageType === "group" && typeof context.groupId === "number") {
    await context.client.sendMessage({ groupId: context.groupId, message: buildMessage(textSegment(text)) });
    return;
  }
  await context.client.sendMessage({ userId: context.userId, message: buildMessage(textSegment(text)) });
}

function parseFaceIdFromTopEmoji(item: TopEmojiItem): number | undefined {
  if (item.kind !== "face") return undefined;
  const matched = item.key.match(/^face:(?:id|face_id|emoji_id):(?<id>\d+)$/);
  const id = matched?.groups?.id;
  if (!id) return undefined;
  const parsed = Number(id);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isLikelyLocalImageRef(value: string): boolean {
  if (!value) return false;
  if (value.startsWith("file://") || value.startsWith("data:") || value.startsWith("base64://")) return true;
  if (/^[a-zA-Z]:\\/.test(value)) return true;
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) return true;
  return false;
}

function canEmbedEmojiImage(assetRef: string | undefined): boolean {
  if (!assetRef) return false;
  if (!isLikelyLocalImageRef(assetRef)) return false;
  if (assetRef.startsWith("data:") || assetRef.startsWith("base64://") || assetRef.startsWith("file://")) return true;
  try {
    return fs.existsSync(assetRef);
  } catch {
    return false;
  }
}

function buildEmojiTop3Text(top3: TopEmojiItem[]): string {
  if (top3.length <= 0) {
    return "今日最受欢迎表情包TOP3：\n今天还没有表情包/表情使用记录";
  }
  const lines = ["今日最受欢迎表情包TOP3："];
  for (const [index, item] of top3.slice(0, 3).entries()) {
    const name = item.kind === "image" ? "表情包" : item.label;
    lines.push(`${index + 1}. ${name} 使用次数：${item.count}次`);
  }
  return lines.join("\n");
}

function buildEmojiStatsMixedMessageParts(imageFile: string, top3: TopEmojiItem[]): MessageInput[] {
  const parts: MessageInput[] = [imageSegment(imageFile)];
  parts.push(textSegment("\n今日最受欢迎表情包TOP3：\n"));

  if (top3.length <= 0) {
    parts.push(textSegment("今天还没有表情包/表情使用记录"));
    return parts;
  }

  for (const [index, item] of top3.slice(0, 3).entries()) {
    parts.push(textSegment(`\n${index + 1}. 使用次数：${item.count}次\n`));

    if (item.kind === "image") {
      if (canEmbedEmojiImage(item.assetRef)) {
        parts.push(imageSegment(item.assetRef!));
        parts.push(textSegment("\n"));
      } else {
        parts.push(textSegment("表情包（图片链接已失效或不可发送）\n"));
      }
      continue;
    }

    const faceId = parseFaceIdFromTopEmoji(item);
    if (faceId !== undefined) {
      parts.push(faceSegment(faceId));
      parts.push(textSegment(` ${item.label}\n`));
      continue;
    }

    parts.push(textSegment(`${item.label}\n`));
  }

  return parts;
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
      name: "talk_stats",
      help: "/发言统计 [群号]",
      cooldownExempt: true,
      parse(message) {
        const matched = message.trim().match(/^\/发言统计(?:\s+(\d+))?$/);
        if (!matched) return null;
        return { groupId: matched[1] ? Number(matched[1]) : undefined };
      },
      async execute(context, payload) {
        const groupId = resolveStatsGroupId(context, payload);
        if (groupId === null) {
          await context.sendText("用法：群内发送 /发言统计，或私聊发送 /发言统计 <群号>");
          return;
        }

        const stats = activityStore.getTodayTalkStats(groupId);
        const imageFile = await renderTalkStatsCard(stats);
        await sendContextImage(context, imageFile);
      },
    }),
    defineCommand({
      name: "emoji_stats",
      help: "/表情包统计 [群号]",
      cooldownExempt: true,
      parse(message) {
        const matched = message.trim().match(/^\/表情包统计(?:\s+(\d+))?$/);
        if (!matched) return null;
        return { groupId: matched[1] ? Number(matched[1]) : undefined };
      },
      async execute(context, payload) {
        const groupId = resolveStatsGroupId(context, payload);
        if (groupId === null) {
          await context.sendText("用法：群内发送 /表情包统计，或私聊发送 /表情包统计 <群号>");
          return;
        }

        const stats = activityStore.getTodayEmojiStats(groupId);
        const top3Raw = activityStore.getTodayTopEmojis(groupId, Date.now(), 3);
        const top3 = await Promise.all(top3Raw.map(async (item) => {
          if (item.kind !== "image" || !item.assetRef) return item;
          const localAsset = await activityStore.ensureEmojiAssetLocal(item.assetRef);
          return { ...item, assetRef: localAsset ?? item.assetRef };
        }));
        const imageFile = await renderEmojiStatsCard(stats);
        const message = buildMessage(...buildEmojiStatsMixedMessageParts(imageFile, top3));
        try {
          if (context.messageType === "group" && typeof context.groupId === "number") {
            await context.client.sendMessage({ groupId: context.groupId, message });
          } else {
            await context.client.sendMessage({ userId: context.userId, message });
          }
        } catch (error) {
          logger.warn("[activity] 表情统计混合消息发送失败，降级为图+文字:", error);
          await sendContextImage(context, imageFile);
          await sendContextTextMessage(context, buildEmojiTop3Text(top3));
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
        await context.sendText([
          `connected=${runtime.connected}`,
          `reconnecting=${runtime.reconnecting}`,
          `inflight=${runtime.inFlightActions}`,
          `queued=${runtime.queuedActions}`,
          `pending=${runtime.pendingActions}`,
          `pong_age_ms=${lastPongAgeMs}`,
          `queue_overflow_count=${runtime.queueOverflowCount}`,
          `retry_count=${runtime.retryCount}`,
          `rate_limit_wait_ms_total=${runtime.rateLimitWaitMsTotal}`,
        ].join("\n"));
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
        const rootUserId =
          typeof config.permissions.rootUserId === "number"
            ? String(config.permissions.rootUserId)
            : "(unset)";
        await context.sendText([
          `rootUserId=${rootUserId}`,
          `cooldownMs=${snapshot.cooldownMs}`,
          `groupReplyMode=@only`,
          `proactiveGroupReply=false`,
          `autoApproveGroup=${config.requests.autoApproveGroup}`,
          `autoApproveFriend=${config.requests.autoApproveFriend}`,
        ].join("\n"));
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

