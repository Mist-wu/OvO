type ExternalCallContext = {
  signal: AbortSignal;
  attempt: number;
};

import {
  isAbortError,
  normalizeError,
  normalizePositiveInt,
} from "./helpers";
import { logger } from "./logger";

type RetryDecider = (error: Error) => boolean;

type ExternalCallErrorReason = "call_failed" | "circuit_open";

type CircuitBreakerOptions = {
  enabled?: boolean;
  key?: string;
  failureThreshold?: number;
  openMs?: number;
};

export type ExternalCallOptions<T = unknown> = {
  service: string;
  operation: string;
  timeoutMs: number;
  signal?: AbortSignal;
  retries?: number;
  retryDelayMs?: number;
  concurrency?: number;
  concurrencyKey?: string;
  isRetryable?: RetryDecider;
  circuitBreaker?: CircuitBreakerOptions;
  fallback?: (error: ExternalCallError) => Promise<T> | T;
};

export class ExternalCallError extends Error {
  readonly service: string;
  readonly operation: string;
  readonly attempts: number;
  readonly retryable: boolean;
  readonly reason: ExternalCallErrorReason;

  constructor(params: {
    service: string;
    operation: string;
    attempts: number;
    retryable: boolean;
    reason: ExternalCallErrorReason;
    cause: Error;
  }) {
    super(
      `[external] ${params.service}.${params.operation} ${params.reason} after ${params.attempts} attempt(s): ${params.cause.message}`,
      { cause: params.cause },
    );
    this.name = "ExternalCallError";
    this.service = params.service;
    this.operation = params.operation;
    this.attempts = params.attempts;
    this.retryable = params.retryable;
    this.reason = params.reason;
  }
}

class ConcurrencyGate {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) { }

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

type CircuitState = {
  failures: number;
  openUntil: number;
};

const gates = new Map<string, ConcurrencyGate>();
const circuits = new Map<string, CircuitState>();

function getGate(key: string, limit: number): ConcurrencyGate {
  const existing = gates.get(key);
  if (existing) return existing;
  const next = new ConcurrencyGate(limit);
  gates.set(key, next);
  return next;
}

function getCircuitState(key: string): CircuitState {
  const existing = circuits.get(key);
  if (existing) return existing;
  const next: CircuitState = { failures: 0, openUntil: 0 };
  circuits.set(key, next);
  return next;
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



function createAbortError(service: string, operation: string): Error {
  const error = new Error(
    `[external] aborted service=${service} operation=${operation}`,
  );
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  if (signal.aborted) {
    return Promise.reject(new Error("aborted"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort);
  });
}

function createTimeoutError(service: string, operation: string, timeoutMs: number): Error {
  const error = new Error(
    `[external] timeout service=${service} operation=${operation} timeout=${timeoutMs}ms`,
  );
  error.name = "ExternalTimeoutError";
  return error;
}

function createCircuitOpenError(
  service: string,
  operation: string,
  msRemaining: number,
): ExternalCallError {
  return new ExternalCallError({
    service,
    operation,
    attempts: 0,
    retryable: false,
    reason: "circuit_open",
    cause: new Error(
      `[external] circuit open service=${service} operation=${operation} reopen_in_ms=${msRemaining}`,
    ),
  });
}

async function resolveFallbackOrThrow<T>(
  fallback: ExternalCallOptions<T>["fallback"],
  error: ExternalCallError,
): Promise<T> {
  if (!fallback) throw error;

  logger.warn(
    `[external] fallback service=${error.service} operation=${error.operation} reason=${error.reason}`,
  );
  return fallback(error);
}

function markCircuitFailure(state: CircuitState, failureThreshold: number, openMs: number): void {
  state.failures += 1;
  if (state.failures >= failureThreshold) {
    state.failures = 0;
    state.openUntil = Date.now() + openMs;
  }
}

function markCircuitSuccess(state: CircuitState): void {
  state.failures = 0;
  state.openUntil = 0;
}

export async function runExternalCall<T>(
  options: ExternalCallOptions<T>,
  runner: (context: ExternalCallContext) => Promise<T>,
): Promise<T> {
  const retries = Math.max(0, Math.floor(options.retries ?? 0));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 150));
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 1));
  const gateKey = options.concurrencyKey?.trim() || options.service;
  const gate = getGate(gateKey, concurrency);
  const shouldRetry = options.isRetryable ?? isRetryableByDefault;

  const circuitEnabled = options.circuitBreaker?.enabled ?? false;
  const circuitFailureThreshold = normalizePositiveInt(
    options.circuitBreaker?.failureThreshold,
    3,
  );
  const circuitOpenMs = normalizePositiveInt(options.circuitBreaker?.openMs, 30000);
  const circuitKey =
    options.circuitBreaker?.key?.trim() || `${options.service}:${options.operation}`;
  const circuitState = circuitEnabled ? getCircuitState(circuitKey) : null;

  if (options.signal?.aborted) {
    const abortedError = new ExternalCallError({
      service: options.service,
      operation: options.operation,
      attempts: 0,
      retryable: false,
      reason: "call_failed",
      cause: createAbortError(options.service, options.operation),
    });
    return resolveFallbackOrThrow(options.fallback, abortedError);
  }

  await gate.acquire();
  try {
    if (circuitState) {
      const now = Date.now();
      if (circuitState.openUntil > now) {
        const openError = createCircuitOpenError(
          options.service,
          options.operation,
          circuitState.openUntil - now,
        );
        return resolveFallbackOrThrow(options.fallback, openError);
      }
    }

    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | null = null;
      let removeParentAbortListener: (() => void) | null = null;

      try {
        if (options.signal) {
          const parentSignal = options.signal;
          const onParentAbort = () => {
            controller.abort();
          };
          parentSignal.addEventListener("abort", onParentAbort);
          removeParentAbortListener = () => {
            parentSignal.removeEventListener("abort", onParentAbort);
          };
        }

        const abortPromise = new Promise<never>((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              reject(createAbortError(options.service, options.operation));
            },
            { once: true },
          );
        });
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(createTimeoutError(options.service, options.operation, timeoutMs));
          }, timeoutMs);
        });

        const result = await Promise.race([
          runner({ signal: controller.signal, attempt }),
          timeoutPromise,
          abortPromise,
        ]);

        if (circuitState) {
          markCircuitSuccess(circuitState);
        }
        return result;
      } catch (error) {
        const normalized = normalizeError(error);
        const abortedByCaller = options.signal?.aborted || isAbortError(normalized);
        if (abortedByCaller) {
          const finalError = new ExternalCallError({
            service: options.service,
            operation: options.operation,
            attempts: attempt,
            retryable: false,
            reason: "call_failed",
            cause: normalized,
          });
          return resolveFallbackOrThrow(options.fallback, finalError);
        }

        const retryable = shouldRetry(normalized);

        if (circuitState) {
          markCircuitFailure(circuitState, circuitFailureThreshold, circuitOpenMs);
        }

        if (retryable && attempt <= retries) {
          logger.warn(
            `[external] retry service=${options.service} operation=${options.operation} attempt=${attempt} reason=${normalized.message}`,
          );
          if (retryDelayMs > 0) {
            try {
              await sleep(retryDelayMs * attempt, options.signal);
            } catch {
              const abortedError = new ExternalCallError({
                service: options.service,
                operation: options.operation,
                attempts: attempt,
                retryable: false,
                reason: "call_failed",
                cause: createAbortError(options.service, options.operation),
              });
              return resolveFallbackOrThrow(options.fallback, abortedError);
            }
          }
          continue;
        }

        const finalError = new ExternalCallError({
          service: options.service,
          operation: options.operation,
          attempts: attempt,
          retryable,
          reason: "call_failed",
          cause: normalized,
        });
        return resolveFallbackOrThrow(options.fallback, finalError);
      } finally {
        if (removeParentAbortListener) {
          removeParentAbortListener();
        }
        if (timer) clearTimeout(timer);
      }
    }

    const impossibleError = new ExternalCallError({
      service: options.service,
      operation: options.operation,
      attempts: retries + 1,
      retryable: false,
      reason: "call_failed",
      cause: new Error("unknown external error"),
    });
    return resolveFallbackOrThrow(options.fallback, impossibleError);
  } finally {
    gate.release();
  }
}
