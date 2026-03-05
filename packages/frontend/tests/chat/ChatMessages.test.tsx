import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@graphen/shared";
import { ChatMessages } from "../../src/chat/ChatMessages";

// Mock react-markdown to avoid ESM issues in jsdom
vi.mock("react-markdown", () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => <p>{children}</p>,
}));

vi.mock("remark-gfm", () => ({
  __esModule: true,
  default: () => {},
}));

// jsdom doesn't implement scrollIntoView
beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const assistantMessage: ChatMessage = {
  id: "msg-1",
  sessionId: "session-1",
  role: "assistant",
  content: "Hello, how can I help?",
  createdAt: new Date("2026-01-01T10:00:00Z"),
};

describe("ChatMessages", () => {
  it("does not render ChatMemoryIndicator after assistant messages", () => {
    render(
      <ChatMessages
        messages={[assistantMessage]}
        isStreaming={false}
        streamingMessage=""
        onOpenDocument={() => {}}
        onOpenGraph={() => {}}
        onGraphNodeClick={() => {}}
      />,
    );

    // The assistant message content should be rendered
    expect(screen.getByText("Hello, how can I help?")).toBeInTheDocument();

    // ChatMemoryIndicator would render elements with memory-related text/classes.
    // Verify none of those exist.
    expect(screen.queryByText(/提取中/)).not.toBeInTheDocument();
    expect(screen.queryByText(/记忆/)).not.toBeInTheDocument();
  });
});
