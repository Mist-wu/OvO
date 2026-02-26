import { logger } from "../../../utils/logger";
import { activityStore, renderSignInCard } from "../../../activity";
import { fetchWeatherSummary } from "../../../utils/weather";
import { buildMessage, image as imageSegment } from "../../message";
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

async function sendContextImage(
  context: CommandExecutionContext,
  imageFile: string,
): Promise<void> {
  const message = buildMessage(imageSegment(imageFile));
  if (context.messageType === "group" && typeof context.groupId === "number") {
    await context.client.sendMessage({ groupId: context.groupId, message });
    return;
  }
  await context.client.sendMessage({ userId: context.userId, message });
}

export function createUserCommands(getHelpText: HelpTextProvider): CommandDefinition<unknown>[] {
  return [
    defineCommand({
      name: "user_help",
      access: "user",
      help: "/帮助",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/帮助" ? emptyPayload : null;
      },
      async execute(context) {
        await context.sendText(getHelpText("user"));
      },
    }),
    defineCommand({
      name: "sign_in",
      access: "user",
      help: "/签到",
      cooldownExempt: true,
      parse(message) {
        return message.trim() === "/签到" ? emptyPayload : null;
      },
      async execute(context) {
        const isGroup = context.messageType === "group" && typeof context.groupId === "number";
        const result = activityStore.signIn({
          scope: isGroup ? "group" : "private",
          scopeId: isGroup ? context.groupId! : context.userId,
          userId: context.userId,
          userName: getSenderNameFromEvent(context.event),
          now:
            typeof context.event.time === "number" && Number.isFinite(context.event.time) && context.event.time > 0
              ? Math.floor(context.event.time * 1000)
              : Date.now(),
        });
        const imageFile = await renderSignInCard(result);
        await sendContextImage(context, imageFile);
      },
    }),
    defineCommand({
      name: "weather",
      access: "user",
      help: "/天气 <城市>",
      parse(message) {
        const matched = message.trim().match(/^\/天气(?:\s+(.+))?$/);
        if (!matched) return null;
        return { location: matched[1]?.trim() || "" };
      },
      async execute(context, payload) {
        const location = (payload as { location?: string }).location || "";
        if (!location) {
          await context.sendText("用法：/天气 <城市>");
          return;
        }

        try {
          const report = await fetchWeatherSummary(location);
          await context.sendText(report);
        } catch (error) {
          logger.warn("[weather] 查询失败:", error);
          const message = error instanceof Error ? error.message : "";
          if (message.includes("WEATHER_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("天气查询失败，请稍后重试");
        }
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
