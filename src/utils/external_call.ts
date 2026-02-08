type ExternalCallContext = {
  signal: AbortSignal;
  attempt: number;
};

type RetryDecider = (error: Error) => boolean;

export type ExternalCallOptions = {
  service: string;
  operation: string;
  timeoutMs: number;
  retries?: number;
  retryDelayMs?: number;
  concurrency?: number;
  concurrencyKey?: string;
  isRetryable?: RetryDecider;
};

export class ExternalCallError extends Error {
  readonly service: string;
  readonly operation: string;
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(params: {
    service: string;
    operation: string;
    attempts: number;
    retryable: boolean;
    cause: Error;
  }) {
    super(
      `[external] ${params.service}.${params.operation} failed after ${params.attempts} attempt(s): ${params.cause.message}`,
      { cause: params.cause },
    );
    this.name = "ExternalCallError";
    this.service = params.service;
    this.operation = params.operation;
    this.attempts = params.attempts;
    this.retryable = params.retryable;
  }
}

class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const wake = this.queue.shift();
    if (wake) wake();
  }
}

const gates = new Map<string, ConcurrencyGate>();

function getGate(key: string, limit: number): ConcurrencyGate {
  const existing = gates.get(key);
  if (existing) return existing;
  const next = new ConcurrencyGate(limit);
  gates.set(key, next);
  return next;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

function isRetryableByDefault(error: Error): boolean {
  const message = `${error.name} ${error.message}`.toLowerCase();

  if (message.includes("timeout") || message.includes("aborted")) return true;
  if (message.includes("econnreset")) return true;
  if (message.includes("econnrefused")) return true;
  if (message.includes("enotfound")) return true;
  if (message.includes("eai_again")) return true;
  if (message.includes("etimedout")) return true;
  if (message.includes("status=429")) return true;
  if (/status=5\d{2}/.test(message)) return true;

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTimeoutError(service: string, operation: string, timeoutMs: number): Error {
  const error = new Error(
    `[external] timeout service=${service} operation=${operation} timeout=${timeoutMs}ms`,
  );
  error.name = "ExternalTimeoutError";
  return error;
}

export async function runExternalCall<T>(
  options: ExternalCallOptions,
  runner: (context: ExternalCallContext) => Promise<T>,
): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 150));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const gateKey = options.concurrencyKey?.trim() || options.service;
  const gate = getGate(gateKey, concurrency);
  const shouldRetry = options.isRetryable ?? isRetryableByDefault;

  await gate.acquire();
  try {
    let lastError: Error | null = null;
    let lastRetryable = false;

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | null = null;

      try {
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(createTimeoutError(options.service, options.operation, timeoutMs));
          }, timeoutMs);
        });

        const result = await Promise.race([
          runner({ signal: controller.signal, attempt }),
          timeoutPromise,
        ]);
        return result;
      } catch (error) {
        const normalized = normalizeError(error);
        const retryable = shouldRetry(normalized);
        lastError = normalized;
        lastRetryable = retryable;

        if (retryable && attempt <= retries) {
          console.warn(
            `[external] retry service=${options.service} operation=${options.operation} attempt=${attempt} reason=${normalized.message}`,
          );
          if (retryDelayMs > 0) {
            await sleep(retryDelayMs * attempt);
          }
          continue;
        }

        throw new ExternalCallError({
          service: options.service,
          operation: options.operation,
          attempts: attempt,
          retryable,
          cause: normalized,
        });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    throw new ExternalCallError({
      service: options.service,
      operation: options.operation,
      attempts: retries + 1,
      retryable: lastRetryable,
      cause: lastError ?? new Error("unknown external error"),
    });
  } finally {
    gate.release();
  }
}
