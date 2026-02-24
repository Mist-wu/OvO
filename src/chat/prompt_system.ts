type PromptValue = string | number | boolean | null | undefined;

export type PromptTemplateVars = Record<string, PromptValue>;

function formatPromptTemplateString(template: string, vars: PromptTemplateVars): string {
  const escaped = template
    .replace(/\\\{/g, "__PROMPT_ESCAPED_L__")
    .replace(/\\\}/g, "__PROMPT_ESCAPED_R__");

  const formatted = escaped.replace(/\{([a-zA-Z0-9_]+)\}/g, (_full, key: string) => {
    if (!(key in vars)) {
      throw new Error(`[prompt] missing template variable: ${key}`);
    }
    const value = vars[key];
    return value === null || value === undefined ? "" : String(value);
  });

  return formatted
    .replace(/__PROMPT_ESCAPED_L__/g, "{")
    .replace(/__PROMPT_ESCAPED_R__/g, "}");
}

export class PromptTemplate {
  constructor(
    public readonly name: string,
    public readonly template: string,
  ) {}

  format(vars: PromptTemplateVars): string {
    return formatPromptTemplateString(this.template, vars);
  }
}

export class PromptManager {
  private readonly templates = new Map<string, PromptTemplate>();

  register(name: string, template: string): PromptTemplate {
    const normalized = name.trim();
    if (!normalized) {
      throw new Error("[prompt] template name is required");
    }
    const created = new PromptTemplate(normalized, template);
    this.templates.set(normalized, created);
    return created;
  }

  get(name: string): PromptTemplate {
    const template = this.templates.get(name);
    if (!template) {
      throw new Error(`[prompt] template not found: ${name}`);
    }
    return template;
  }

  format(name: string, vars: PromptTemplateVars): string {
    return this.get(name).format(vars);
  }
}

export const chatPromptManager = new PromptManager();

