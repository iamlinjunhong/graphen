import type { LLMRateLimitConfig } from "./llmTypes.js";

interface QueuedTask<T> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export class LLMRateLimiter {
  private readonly config: LLMRateLimitConfig;
  private activeCount = 0;
  private readonly queue: QueuedTask<any>[] = [];
  private readonly requestTimestamps: number[] = [];
  private waitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: Partial<LLMRateLimitConfig> = {}) {
    this.config = {
      maxConcurrent: config.maxConcurrent ?? 5,
      maxRetries: config.maxRetries ?? 3,
      retryDelayMs: config.retryDelayMs ?? 1000,
      requestsPerMinute: config.requestsPerMinute ?? 30,
      timeoutMs: config.timeoutMs ?? 60_000
    };
  }

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        task: task as () => Promise<any>,
        resolve: resolve as (value: any) => void,
        reject
      });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    this.clearWaitTimer();
    this.pruneRequestWindow();

    while (this.activeCount < this.config.maxConcurrent && this.queue.length > 0) {
      const waitMs = this.getWaitMsForRateLimit();
      if (waitMs > 0) {
        this.waitTimer = setTimeout(() => {
          this.waitTimer = null;
          this.drainQueue();
        }, waitMs);
        return;
      }

      const item = this.queue.shift();
      if (!item) {
        return;
      }

      this.activeCount += 1;
      this.requestTimestamps.push(Date.now());
      this.executeTask(item).finally(() => {
        this.activeCount -= 1;
        this.drainQueue();
      });
    }
  }

  private async executeTask<T>(item: QueuedTask<T>): Promise<void> {
    let attempt = 0;

    while (true) {
      try {
        const result = await this.withTimeout(item.task(), this.config.timeoutMs);
        item.resolve(result);
        return;
      } catch (error) {
        const shouldRetry = this.isRetryableError(error) && attempt < this.config.maxRetries;
        if (!shouldRetry) {
          item.reject(error);
          return;
        }

        attempt += 1;
        const backoff = this.config.retryDelayMs * 2 ** (attempt - 1);
        await this.sleep(backoff);
      }
    }
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    if (timeoutMs <= 0) {
      return promise;
    }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`LLM request timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private isRetryableError(error: unknown): boolean {
    const err = error as { status?: number; code?: string; message?: string };
    if (typeof err?.status === "number") {
      return err.status === 429 || err.status >= 500;
    }
    if (typeof err?.code === "string") {
      return ["ETIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(err.code);
    }
    if (typeof err?.message === "string") {
      return /timeout|timed out|temporarily unavailable/i.test(err.message);
    }
    return false;
  }

  private pruneRequestWindow(): void {
    const cutoff = Date.now() - 60_000;
    while (this.requestTimestamps.length > 0) {
      const first = this.requestTimestamps[0];
      if (first === undefined || first >= cutoff) {
        break;
      }
      this.requestTimestamps.shift();
    }
  }

  private getWaitMsForRateLimit(): number {
    if (this.requestTimestamps.length < this.config.requestsPerMinute) {
      return 0;
    }

    const firstInWindow = this.requestTimestamps[0];
    if (!firstInWindow) {
      return 0;
    }

    const elapsed = Date.now() - firstInWindow;
    return Math.max(0, 60_000 - elapsed);
  }

  private clearWaitTimer(): void {
    if (this.waitTimer) {
      clearTimeout(this.waitTimer);
      this.waitTimer = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
