import type { LoadedSkill, SkillCapability } from "./types";
import { SkillLoader } from "./loader";

function normalizeKey(value: string): string {
  return value.trim().toLowerCase();
}

export class SkillRegistry {
  private loaded = false;
  private skills: LoadedSkill[] = [];
  private byName = new Map<string, LoadedSkill>();
  private byCapability = new Map<string, LoadedSkill[]>();

  constructor(private readonly loader: SkillLoader) {}

  ensureLoaded(): void {
    if (this.loaded) return;
    this.reload();
  }

  reload(): void {
    this.skills = this.loader.loadAll();
    this.byName.clear();
    this.byCapability.clear();

    for (const skill of this.skills) {
      this.byName.set(normalizeKey(skill.name), skill);

      const capability = (skill.capability ?? "").trim();
      if (!capability) continue;
      const key = normalizeKey(capability);
      const current = this.byCapability.get(key) ?? [];
      current.push(skill);
      this.byCapability.set(key, current);
    }

    this.loaded = true;
  }

  list(): LoadedSkill[] {
    this.ensureLoaded();
    return this.skills.slice();
  }

  getByName(name: string): LoadedSkill | undefined {
    this.ensureLoaded();
    return this.byName.get(normalizeKey(name));
  }

  findFirstByCapability(capability: SkillCapability): LoadedSkill | undefined {
    this.ensureLoaded();
    const values = this.byCapability.get(normalizeKey(String(capability)));
    if (!values || values.length <= 0) return undefined;
    return values[0];
  }
}
