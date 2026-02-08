import { createRootCommands } from "./definitions/root";
import { createUserCommands } from "./definitions/user";
import type { CommandDefinition, ParsedCommand } from "./types";

type HelpScope = "root" | "user";

let commandRegistry: CommandDefinition<unknown>[] = [];

function getCommandHelpText(scope: HelpScope): string {
  return commandRegistry
    .filter((definition) => {
      if (!definition.help) return false;
      const access = definition.access ?? "root";
      if (scope === "root") return true;
      return access === "user";
    })
    .map((definition) => definition.help?.trim() || "")
    .filter(Boolean)
    .join("\n");
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
