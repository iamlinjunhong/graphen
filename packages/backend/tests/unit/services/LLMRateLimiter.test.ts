import { describe, expect, it } from "vitest";
import { LLMRateLimiter } from "../../../src/services/LLMRateLimiter.js";

describe("LLMRateLimiter", () => {
  it("retries retryable failures with exponential backoff", async () => {
    const limiter = new LLMRateLimiter({
      maxConcurrent: 1,
      maxRetries: 3,
      retryDelayMs: 1,
      requestsPerMinute: 100,
      timeoutMs: 5000
    });

    let attempt = 0;
    const result = await limiter.run(async () => {
      attempt += 1;
      if (attempt < 3) {
        const error = new Error("temporary");
        (error as Error & { status: number }).status = 429;
        throw error;
      }
      return "ok";
    });

    expect(result).toBe("ok");
    expect(attempt).toBe(3);
  });

  it("honors maxConcurrent", async () => {
    const limiter = new LLMRateLimiter({
      maxConcurrent: 2,
      maxRetries: 0,
      retryDelayMs: 1,
      requestsPerMinute: 100,
      timeoutMs: 5000
    });

    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 6 }).map((_, idx) =>
        limiter.run(async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => {
            setTimeout(resolve, 20 + idx * 2);
          });
          inFlight -= 1;
          return idx;
        })
      )
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});
