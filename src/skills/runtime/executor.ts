import { fetchWeatherSummary } from "../../utils/weather";
import type { SkillExecutionIntent, SkillExecutionResult } from "./types";
import { SkillRegistry } from "./registry";

export class SkillExecutor {
  constructor(private readonly registry: SkillRegistry) {}

  async execute(intent: SkillExecutionIntent): Promise<SkillExecutionResult> {
    const skill = this.registry.findFirstByCapability(intent.capability);
    if (!skill) {
      return {
        handled: false,
        reason: "skill_not_found",
      };
    }

    if (intent.capability === "weather") {
      return this.executeWeather(skill.name, intent.location);
    }
    return this.executeSearch(skill.name, intent.query);
  }

  private async executeWeather(skillName: string, location: string): Promise<SkillExecutionResult> {
    try {
      const text = await fetchWeatherSummary(location);
      return {
        handled: true,
        mode: "direct",
        skillName,
        text,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("WEATHER_API_KEY")) {
        return {
          handled: true,
          mode: "direct",
          skillName,
          text: message,
        };
      }
      return {
        handled: true,
        mode: "direct",
        skillName,
        text: "天气查询失败，请稍后重试",
      };
    }
  }

  private async executeSearch(skillName: string, query: string): Promise<SkillExecutionResult> {
    const contextText = [
      `工具结果（技能搜索：${skillName}）`,
      `查询：${query}`,
      "当前搜索技能未接入实时网页源，请基于已有知识回答，并明确不确定部分。",
    ].join("\n");

    return {
      handled: true,
      mode: "context",
      skillName,
      text: contextText,
      fallbackText: `我目前没有实时联网搜索源，先按已有知识回答：${query}`,
    };
  }
}
