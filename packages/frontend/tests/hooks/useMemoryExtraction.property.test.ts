// Feature: chat-memory-manual-trigger, Property 1: Polling bound
// **Validates: Requirements 4.2**
//
// For any session ID, when memory extraction is triggered, the hook shall call
// loadFactsByChatSessionId at most 5 times total before transitioning to "done".

import { renderHook, act } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { useMemoryExtraction } from "../../src/hooks/useMemoryExtraction";
import { apiClient } from "../../src/services/api";
import { useMemoryStore } from "../../src/stores/useMemoryStore";

describe("Property 1: Polling bound", () => {
  it("for any session ID, loadFactsByChatSessionId is called at most 5 times", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uuid(), async (sessionId) => {
        // Setup per-iteration: fake timers and mock
        vi.useFakeTimers();
        const mockLoadFacts = vi.fn<(sessionId: string) => Promise<void>>();
        mockLoadFacts.mockResolvedValue(undefined);
        const triggerSpy = vi
          .spyOn(apiClient.chat, "triggerMemoryExtraction")
          .mockResolvedValue({
            sessionId,
            scanned: 1,
            queued: 1,
            skipped: 0
          });
        useMemoryStore.getState().reset();
        useMemoryStore.setState({ loadFactsByChatSessionId: mockLoadFacts as any });

        const { result, unmount } = renderHook(() => useMemoryExtraction());

        // Trigger extraction
        await act(async () => {
          result.current.startExtraction(sessionId);
          await Promise.resolve();
        });

        // Advance timers well beyond the full polling cycle (5 polls × 2s = 10s)
        for (let i = 0; i < 6; i++) {
          await act(async () => {
            vi.advanceTimersByTime(2000);
          });
        }

        // Assert at most 5 calls
        const callCount = mockLoadFacts.mock.calls.length;
        expect(callCount).toBeLessThanOrEqual(5);

        // Assert all calls used the correct session ID
        for (const call of mockLoadFacts.mock.calls) {
          expect(call[0]).toBe(sessionId);
        }

        // Assert final status is "done"
        expect(result.current.status).toBe("done");

        // Cleanup per-iteration
        triggerSpy.mockRestore();
        unmount();
        vi.useRealTimers();
      }),
      { numRuns: 100 },
    );
  });
});
