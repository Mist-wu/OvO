import { calculateExpressionSummary } from "../../utils/calc";
import { fetchFxSummary } from "../../utils/fx";
import { formatSearchContext, searchWeb } from "../../utils/search_web";
import { getTimeSummary } from "../../utils/time";
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
    if (intent.capability === "search") {
      return this.executeSearch(skill.name, intent.query);
    }
    if (intent.capability === "time") {
      return this.executeTime(skill.name, {
        timezone: intent.timezone,
        label: intent.label,
      });
    }
    if (intent.capability === "fx") {
      return this.executeFx(skill.name, {
        amount: intent.amount,
        from: intent.from,
        to: intent.to,
      });
    }
    if (intent.capability === "calc") {
      return this.executeCalc(skill.name, intent.expression);
    }
    return {
      handled: false,
      reason: "unsupported",
    };
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
    const items = await searchWeb(query);
    const contextText = formatSearchContext(query, items);
    const fallbackText =
      items.length > 0 && items[0].source === "fallback"
        ? items[0].snippet
        : `我先根据最新检索结果总结一下：${query}`;

    return {
      handled: true,
      mode: "context",
      skillName,
      text: contextText,
      fallbackText,
    };
  }

  private async executeTime(
    skillName: string,
    input: {
      timezone: string;
      label: string;
    },
  ): Promise<SkillExecutionResult> {
    return {
      handled: true,
      mode: "direct",
      skillName,
      text: getTimeSummary(input),
    };
  }

  private async executeFx(
    skillName: string,
    input: {
      amount: number;
      from: string;
      to: string;
    },
  ): Promise<SkillExecutionResult> {
    const text = await fetchFxSummary(input);
    return {
      handled: true,
      mode: "direct",
      skillName,
      text,
    };
  }

  private async executeCalc(skillName: string, expression: string): Promise<SkillExecutionResult> {
    return {
      handled: true,
      mode: "direct",
      skillName,
      text: calculateExpressionSummary(expression),
    };
  }
}
