import fs from "node:fs";
import { logger } from "../../../utils/logger";
import { config } from "../../../config";
import {
  activityStore,
  renderEmojiStatsCard,
  renderRechargeCard,
  renderTalkStatsCard,
  renderTransferCard,
  type TopEmojiItem,
} from "../../../activity";
import { askGemini } from "../../../llm";
import { configStore } from "../../../storage/config_store";
import {
  buildMessage,
  face as faceSegment,
  image as imageSegment,
  text as textSegment,
  type MessageInput,
  type MessageSegment,
} from "../../message";
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

function parsePointsTargetCommand(
  message: string,
  command: "/充值" | "/转积分",
): { points: number; targetUserId?: number } | null {
  const parts = splitParts(message);
  if (parts[0] !== command || (parts.length !== 2 && parts.length !== 3)) return null;

  const points = parseNumber(parts[1]);
  if (points === null) return null;

  if (parts.length === 2) {
    return { points };
  }

  const targetUserId = parseNumber(parts[2]);
  if (targetUserId === null) return null;
  return { points, targetUserId };
}

function extractFirstMentionedUserId(
  segments: MessageSegment[] | undefined,
  options?: { selfId?: number | string },
): number | undefined {
  if (!Array.isArray(segments)) return undefined;
  const selfIdText =
    typeof options?.selfId === "number" || typeof options?.selfId === "string" ? String(options.selfId) : "";
  for (const segment of segments) {
    if (segment.type !== "at") continue;
    const qq = segment.data?.qq;
    if (qq === "all") continue;
    const qqText = typeof qq === "number" || typeof qq === "string" ? String(qq).trim() : "";
    if (!qqText) continue;
    if (selfIdText && qqText === selfIdText) continue;
    const parsed = Number(qqText);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    return Math.floor(parsed);
  }
  return undefined;
}

function resolveTargetUserId(
  context: CommandExecutionContext,
  payload: unknown,
): number | undefined {
  const payloadTarget = (payload as { targetUserId?: number }).targetUserId;
  if (typeof payloadTarget === "number" && Number.isFinite(payloadTarget) && payloadTarget > 0) {
    return Math.floor(payloadTarget);
  }
  const selfId =
    typeof context.event.self_id === "number" || typeof context.event.self_id === "string"
      ? context.event.self_id
      : undefined;
  const segments = Array.isArray(context.event.message) ? (context.event.message as MessageSegment[]) : undefined;
  return extractFirstMentionedUserId(segments, { selfId });
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

async function sendContextMixedMessage(
  context: CommandExecutionContext,
  parts: MessageInput[],
): Promise<void> {
  const message = buildMessage(...parts);
  if (context.messageType === "group" && typeof context.groupId === "number") {
    await context.client.sendMessage({ groupId: context.groupId, message });
    return;
  }
  await context.client.sendMessage({ userId: context.userId, message });
}

function resolveCommandNowMs(context: CommandExecutionContext): number {
  const ts = context.event.time;
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    return Math.floor(ts * 1000);
  }
  return Date.now();
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

function buildEmojiTop3Text(top3: TopEmojiItem[], title = "今日最受欢迎表情包TOP3："): string {
  if (top3.length <= 0) {
    return `${title}\n今天还没有表情包/表情使用记录`;
  }
  const lines = [title];
  for (const [index, item] of top3.slice(0, 3).entries()) {
    const name = item.kind === "image" ? "表情包" : item.label;
    lines.push(`${index + 1}. ${name} 使用次数：${item.count}次`);
  }
  return lines.join("\n");
}

function buildEmojiTop3MixedMessageParts(top3: TopEmojiItem[], title: string): MessageInput[] {
  const parts: MessageInput[] = [textSegment(`${title}\n`)];

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

async function resolveEmojiTop3Assets(top3Raw: TopEmojiItem[]): Promise<TopEmojiItem[]> {
  return Promise.all(top3Raw.map(async (item) => {
    if (item.kind !== "image" || !item.assetRef) return item;
    const localAsset = await activityStore.ensureEmojiAssetLocal(item.assetRef);
    return { ...item, assetRef: localAsset ?? item.assetRef };
  }));
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
      access: "user",
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
      access: "user",
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
        const top3 = await resolveEmojiTop3Assets(top3Raw);
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
      name: "yesterday_stats",
      access: "user",
      help: "/昨日统计 [群号]",
      cooldownExempt: true,
      parse(message) {
        const matched = message.trim().match(/^\/昨日统计(?:\s+(\d+))?$/);
        if (!matched) return null;
        return { groupId: matched[1] ? Number(matched[1]) : undefined };
      },
      async execute(context, payload) {
        const groupId = resolveStatsGroupId(context, payload);
        if (groupId === null) {
          await context.sendText("用法：群内发送 /昨日统计，或私聊发送 /昨日统计 <群号>");
          return;
        }

        const nowMs = resolveCommandNowMs(context);
        const yesterdayMs = nowMs - 24 * 60 * 60 * 1000;

        const talkStats = activityStore.getTodayTalkStats(groupId, yesterdayMs);
        const talkImage = await renderTalkStatsCard(talkStats);
        await sendContextImage(context, talkImage);

        const top3Raw = activityStore.getTodayTopEmojis(groupId, yesterdayMs, 3);
        const top3 = await resolveEmojiTop3Assets(top3Raw);
        try {
          await sendContextMixedMessage(context, buildEmojiTop3MixedMessageParts(top3, "昨日最受欢迎表情包TOP3："));
        } catch (error) {
          logger.warn("[activity] 昨日统计TOP3发送失败，降级为文字:", error);
          await sendContextTextMessage(context, buildEmojiTop3Text(top3, "昨日最受欢迎表情包TOP3："));
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
      name: "recharge_points",
      help: "/充值 <积分> <QQ号|@目标>",
      cooldownExempt: true,
      parse(message) {
        return parsePointsTargetCommand(message, "/充值");
      },
      async execute(context, payload) {
        const { points } = payload as { points: number; targetUserId?: number };
        const userId = resolveTargetUserId(context, payload);
        if (!userId) {
          await context.sendText("用法：/充值 <积分> <QQ号|@目标>");
          return;
        }
        const now =
          typeof context.event.time === "number" && Number.isFinite(context.event.time) && context.event.time > 0
            ? Math.floor(context.event.time * 1000)
            : Date.now();
        const result = activityStore.addUserPoints({ userId, points, now });
        const imageFile = await renderRechargeCard(result);
        await sendContextImage(context, imageFile);
      },
    }),
    defineCommand({
      name: "transfer_points",
      access: "user",
      help: "/转积分 <积分> <QQ号|@目标>",
      cooldownExempt: true,
      parse(message) {
        return parsePointsTargetCommand(message, "/转积分");
      },
      async execute(context, payload) {
        const { points } = payload as { points: number; targetUserId?: number };
        const targetUserId = resolveTargetUserId(context, payload);
        if (!targetUserId) {
          await context.sendText("用法：/转积分 <积分> <QQ号|@目标>");
          return;
        }
        if (targetUserId === context.userId) {
          await context.sendText("不能给自己转积分");
          return;
        }

        const senderName = getSenderNameFromEvent(context.event);
        const now = resolveCommandNowMs(context);

        try {
          const receiverSnapshot = activityStore.getUserPoints({ userId: targetUserId });
          const result = activityStore.transferUserPoints({
            fromUserId: context.userId,
            toUserId: targetUserId,
            points,
            fromUserName: senderName,
            toUserName: receiverSnapshot.userName,
            now,
          });
          const imageFile = await renderTransferCard(result);
          await sendContextImage(context, imageFile);
        } catch (error) {
          const message = error instanceof Error ? error.message : "";
          if (message.includes("insufficient points")) {
            const pointsSnapshot = activityStore.getUserPoints({ userId: context.userId, userName: senderName });
            await context.sendText(`积分不足，当前仅有 ${pointsSnapshot.totalPoints} 积分`);
            return;
          }
          logger.warn("[activity] /转积分 失败:", error);
          await context.sendText("转积分失败，请稍后重试");
        }
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

function getSenderNameFromEvent(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const sender = (event as { sender?: unknown }).sender;
  if (!sender || typeof sender !== "object") return undefined;
  const record = sender as { card?: unknown; nickname?: unknown };
  if (typeof record.card === "string" && record.card.trim()) return record.card.trim();
  if (typeof record.nickname === "string" && record.nickname.trim()) return record.nickname.trim();
  return undefined;
}

