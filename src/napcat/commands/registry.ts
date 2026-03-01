import { createRootCommands } from "./definitions/root";
import { createUserCommands } from "./definitions/user";
import type { CommandDefinition, ParsedCommand } from "./types";

type HelpScope = "root" | "user";

let commandRegistry: CommandDefinition<unknown>[] = [];

function getCommandHelpText(scope: HelpScope): string {
  const entries = commandRegistry
    .filter((definition) => {
      if (!definition.help) return false;
      const access = definition.access ?? "root";
      if (scope === "root") return true;
      return access === "user";
    });

  const preferred = scope === "root" ? "/help" : "/帮助";
  const helps = entries
    .map((definition, index) => ({
      help: definition.help?.trim() || "",
      access: definition.access ?? "root",
      index,
    }))
    .filter((item) => Boolean(item.help))
    .sort((a, b) => {
      if (a.help === preferred && b.help !== preferred) return -1;
      if (b.help === preferred && a.help !== preferred) return 1;

      // /help 视图下，管理员指令固定排在普通用户指令前，组内保持注册顺序。
      if (scope === "root") {
        const aOrder = a.access === "root" ? 0 : 1;
        const bOrder = b.access === "root" ? 0 : 1;
        if (aOrder !== bOrder) return aOrder - bOrder;
      }

      return a.index - b.index;
    })
    .map((item) => item.help);

  return helps.join("\n");
}

function createBuiltInCommands(): CommandDefinition<unknown>[] {
  return [...createRootCommands(getCommandHelpText), ...createUserCommands(getCommandHelpText)];
}

commandRegistry = createBuiltInCommands();

export function registerCommand(definition: CommandDefinition<unknown>): void {
  commandRegistry.push(definition);
}

export function getCommandRegistry(): readonly CommandDefinition<unknown>[] {
  return commandRegistry;
}

export function parseCommand(message: string): ParsedCommand | null {
  for (const definition of commandRegistry) {
    const payload = definition.parse(message);
    if (payload === null) continue;
    return { definition, payload };
  }
  return null;
}
