type PostJsonOptions = {
  headers?: Record<string, string>;
  body: unknown;
  timeoutMs: number;
};

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function postJson(url: string, options: PostJsonOptions): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, options.timeoutMs));

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers ?? {}),
      },
      body: JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let data: unknown = {};
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!response.ok) {
      throw new Error(
        `[llm] request failed status=${response.status} provider_response=${safeStringify(data)}`,
      );
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

export function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}
