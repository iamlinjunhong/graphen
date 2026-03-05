// Feature: chat-memory-manual-trigger, Property 2: Summary count accuracy
// **Validates: Requirements 5.1**
//
// For any non-empty array of MemoryFact objects, the MemoryFactsPanel summary
// text shall contain the string `新增 ${facts.length} 条记忆`.
//
// Feature: chat-memory-manual-trigger, Property 3: Facts panel rendering correctness
// **Validates: Requirements 5.5, 5.6**
//
// For any array of MemoryFact objects, the MemoryFactsPanel (when expanded)
// shall render exactly facts.length MemoryFactCard elements and shall display
// a warning icon iff at least one fact has reviewStatus === "conflicted".

import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { MemoryFact, FactReviewStatus, FactValueType } from "@graphen/shared";
import { MemoryFactsPanel } from "../../src/memory/MemoryFactsPanel";

// Mock MemoryFactCard to simplify — use data-testid for counting
vi.mock("../../src/memory/MemoryFactCard", () => ({
  MemoryFactCard: ({ fact, compact }: { fact: MemoryFact; compact: boolean }) => (
    <div data-testid="memory-fact-card" data-compact={compact}>
      {fact.predicate}
    </div>
  ),
}));

// Mock framer-motion to avoid animation issues in tests
vi.mock("framer-motion", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

afterEach(cleanup);

// --- Generators ---

const reviewStatusArb: fc.Arbitrary<FactReviewStatus> = fc.constantFrom(
  "auto",
  "confirmed",
  "conflicted",
  "rejected",
);

const valueTypeArb: fc.Arbitrary<FactValueType> = fc.constantFrom(
  "entity",
  "text",
  "number",
  "date",
);

const isoDateArb = fc.date({ min: new Date("2020-01-01T00:00:00.000Z"), max: new Date("2030-01-01T00:00:00.000Z"), noInvalidDate: true })
  .map((d) => d.toISOString());

const memoryFactArb: fc.Arbitrary<MemoryFact> = fc.record({
  id: fc.uuid(),
  subjectNodeId: fc.uuid(),
  predicate: fc.string({ minLength: 1, maxLength: 30 }),
  objectText: fc.string({ minLength: 1, maxLength: 50 }),
  valueType: valueTypeArb,
  normalizedKey: fc.string({ minLength: 1, maxLength: 80 }),
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  reviewStatus: reviewStatusArb,
  firstSeenAt: isoDateArb,
  lastSeenAt: isoDateArb,
  createdAt: isoDateArb,
  updatedAt: isoDateArb,
});

// Non-empty array of facts with unique IDs (1-50 items)
const nonEmptyFactsArb = fc
  .array(memoryFactArb, { minLength: 1, maxLength: 50 })
  .map((facts) =>
    facts.map((f, i) => ({ ...f, id: `fact-${i}` })),
  );

// Array of facts (0-50 items) with unique IDs
const factsArb = fc
  .array(memoryFactArb, { minLength: 0, maxLength: 50 })
  .map((facts) =>
    facts.map((f, i) => ({ ...f, id: `fact-${i}` })),
  );

describe("Property 2: Summary count accuracy", () => {
  it("for any non-empty MemoryFact array, summary contains correct count", () => {
    fc.assert(
      fc.property(nonEmptyFactsArb, (facts) => {
        const hasConflicted = facts.some((f) => f.reviewStatus === "conflicted");
        const { unmount } = render(
          <MemoryFactsPanel facts={facts} hasConflicted={hasConflicted} />,
        );

        const expectedText = `新增 ${facts.length} 条记忆`;
        expect(screen.getByText(`提取完成 · ${expectedText}`)).toBeInTheDocument();

        unmount();
      }),
      { numRuns: 100 },
    );
  });
});


describe("Property 3: Facts panel rendering correctness", () => {
  it("renders correct number of MemoryFactCards and shows warning icon iff any fact is conflicted", () => {
    fc.assert(
      fc.property(factsArb, (facts) => {
        const hasConflicted = facts.some((f) => f.reviewStatus === "conflicted");
        const { unmount } = render(
          <MemoryFactsPanel facts={facts} hasConflicted={hasConflicted} />,
        );

        if (facts.length > 0) {
          // Click expand toggle to show fact cards
          const toggle = screen.getByText("展开");
          fireEvent.click(toggle);

          // Assert exactly facts.length MemoryFactCard elements
          const cards = screen.getAllByTestId("memory-fact-card");
          expect(cards).toHaveLength(facts.length);

          // Verify each card has compact={true}
          for (const card of cards) {
            expect(card.getAttribute("data-compact")).toBe("true");
          }
        } else {
          // No cards should be rendered when empty
          expect(screen.queryAllByTestId("memory-fact-card")).toHaveLength(0);
          // No expand toggle
          expect(screen.queryByText("展开")).not.toBeInTheDocument();
        }

        // Warning icon: present iff hasConflicted
        const warningIcon = document.querySelector(".memory-facts-warning");
        if (hasConflicted) {
          expect(warningIcon).toBeInTheDocument();
        } else {
          expect(warningIcon).not.toBeInTheDocument();
        }

        unmount();
      }),
      { numRuns: 100 },
    );
  });
});
