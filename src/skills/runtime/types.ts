export type SkillCapability = "weather" | "search" | "time" | "fx" | "calc" | string;

export type SkillFrontMatter = {
  name: string;
  description: string;
  capability?: SkillCapability;
  mode?: "direct" | "context";
  [key: string]: string | undefined;
};

export type LoadedSkill = {
  name: string;
  description: string;
  capability?: SkillCapability;
  mode: "direct" | "context";
  baseDir: string;
  skillPath: string;
  frontMatter: SkillFrontMatter;
};

export type SkillExecutionResult =
  | {
      handled: false;
      reason: "skill_not_found" | "unsupported" | "failed";
      message?: string;
    }
  | {
      handled: true;
      mode: "direct" | "context";
      skillName: string;
      text: string;
      fallbackText?: string;
    };

export type SkillExecutionIntent =
  | {
      capability: "weather";
      location: string;
      query: string;
    }
  | {
      capability: "search";
      query: string;
    }
  | {
      capability: "time";
      timezone: string;
      label: string;
      query: string;
    }
  | {
      capability: "fx";
      amount: number;
      from: string;
      to: string;
      query: string;
    }
  | {
      capability: "calc";
      expression: string;
      query: string;
    };
