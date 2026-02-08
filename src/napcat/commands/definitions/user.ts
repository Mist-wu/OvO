import { askGemini } from "../../../llm";
import { fetchWeatherSummary } from "../../../utils/weather";
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
          console.warn("[weather] 查询失败:", error);
          const message = error instanceof Error ? error.message : "";
          if (message.includes("WEATHER_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("天气查询失败，请稍后重试");
        }
      },
    }),
    defineCommand({
      name: "ask",
      access: "user",
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
          console.warn("[llm] /问 失败:", error);
          const message = error instanceof Error ? error.message : "";
          if (message.includes("GEMINI_API_KEY")) {
            await context.sendText(message);
            return;
          }
          await context.sendText("问答失败，请稍后重试");
        }
      },
    }),
  ];
}
