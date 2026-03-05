import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMemoryExtraction } from "../../src/hooks/useMemoryExtraction";
import { apiClient } from "../../src/services/api";
import { useMemoryStore } from "../../src/stores/useMemoryStore";

// We mock loadFactsByChatSessionId at the store level since the hook
// calls it directly via useMemoryStore selector.
const mockLoadFacts = vi.fn<(sessionId: string) => Promise<void>>();
const mockTriggerExtraction = vi.spyOn(apiClient.chat, "triggerMemoryExtraction");

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useMemoryStore.getState().reset();
  mockTriggerExtraction.mockResolvedValue({
    sessionId: "session-1",
    scanned: 1,
    queued: 1,
    skipped: 0
  });
  // Override the store's loadFactsByChatSessionId with our mock
  mockLoadFacts.mockResolvedValue(undefined);
  useMemoryStore.setState({ loadFactsByChatSessionId: mockLoadFacts as any });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useMemoryExtraction", () => {
  it("calls loadFactsByChatSessionId immediately on startExtraction", async () => {
    const { result } = renderHook(() => useMemoryExtraction());

    await act(async () => {
      result.current.startExtraction("session-1");
      await Promise.resolve();
    });

    expect(mockTriggerExtraction).toHaveBeenCalledWith("session-1");
    expect(mockLoadFacts).toHaveBeenCalledWith("session-1");
    expect(result.current.status).toBe("extracting");
  });

  it("polls up to 5 times then transitions to done", async () => {
    const { result } = renderHook(() => useMemoryExtraction());

    await act(async () => {
      result.current.startExtraction("session-1");
      await Promise.resolve();
    });

    // Initial call = 1
    expect(mockLoadFacts).toHaveBeenCalledTimes(1);

    // Advance through intervals until done
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        vi.advanceTimersByTime(2000);
      });
    }

    expect(result.current.status).toBe("done");
  });

  it("stops polling and resets to idle on error", async () => {
    // First call succeeds (initial), second call (first interval) rejects
    mockLoadFacts
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Network error"));

    const { result } = renderHook(() => useMemoryExtraction());

    await act(async () => {
      result.current.startExtraction("session-1");
      await Promise.resolve();
    });

    expect(result.current.status).toBe("extracting");

    // Advance to trigger the interval callback which will call the rejecting mock
    await act(async () => {
      vi.advanceTimersByTime(2000);
      // Flush microtasks so the .catch() handler runs
      await Promise.resolve();
    });

    expect(result.current.status).toBe("idle");

    // No more polls should happen after error
    const callCountAfterError = mockLoadFacts.mock.calls.length;
    await act(async () => {
      vi.advanceTimersByTime(4000);
    });
    expect(mockLoadFacts.mock.calls.length).toBe(callCountAfterError);
  });

  it("resets status to idle when reset() is called", async () => {
    const { result } = renderHook(() => useMemoryExtraction());

    await act(async () => {
      result.current.startExtraction("session-1");
      await Promise.resolve();
    });

    expect(result.current.status).toBe("extracting");

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
  });
});
