import fs from "node:fs";
import path from "node:path";

import type { LoadedSkill, SkillFrontMatter } from "./types";

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function normalizeMode(value: string | undefined): "direct" | "context" {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "context" ? "context" : "direct";
}

function parseFrontMatter(content: string): SkillFrontMatter | null {
  const lines = content.split(/\r?\n/);
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return null;
  }

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return null;

  const raw: Record<string, string> = {};
  for (let i = 1; i < end; i += 1) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const splitIndex = line.indexOf(":");
    if (splitIndex <= 0) continue;
    const key = line.slice(0, splitIndex).trim();
    const value = stripQuotes(line.slice(splitIndex + 1));
    if (!key || !value) continue;
    raw[key] = value;
  }

  const name = (raw.name ?? "").trim();
  const description = (raw.description ?? "").trim();
  if (!name || !description) {
    return null;
  }

  return {
    ...raw,
    name,
    description,
    capability: raw.capability?.trim() || undefined,
    mode: normalizeMode(raw.mode),
  };
}

export class SkillLoader {
  constructor(private readonly skillsRoot: string) {}

  loadAll(): LoadedSkill[] {
    if (!fs.existsSync(this.skillsRoot)) {
      return [];
    }

    const skills: LoadedSkill[] = [];
    const entries = fs.readdirSync(this.skillsRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const baseDir = path.join(this.skillsRoot, entry.name);
      const skillPath = path.join(baseDir, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;

      try {
        const content = fs.readFileSync(skillPath, "utf8");
        const frontMatter = parseFrontMatter(content);
        if (!frontMatter) continue;

        skills.push({
          name: frontMatter.name,
          description: frontMatter.description,
          capability: frontMatter.capability,
          mode: normalizeMode(frontMatter.mode),
          baseDir,
          skillPath,
          frontMatter,
        });
      } catch (error) {
        console.warn(`[skills] load failed: ${skillPath}`, error);
      }
    }

    return skills;
  }
}
