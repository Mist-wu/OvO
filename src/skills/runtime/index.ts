import path from "node:path";

import { SkillExecutor } from "./executor";
import { SkillLoader } from "./loader";
import { SkillRegistry } from "./registry";

const skillsRoot = path.resolve(process.cwd(), "src/skills");
const skillLoader = new SkillLoader(skillsRoot);
const skillRegistry = new SkillRegistry(skillLoader);

export const runtimeSkills = {
  loader: skillLoader,
  registry: skillRegistry,
  executor: new SkillExecutor(skillRegistry),
};
