import { cleanup, render, screen, fireEvent, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockNavigate = vi.fn();
vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

let mockIsStreaming = false;
let mockIsConnecting = false;
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/hooks/useChatStream", () => ({
  useChatStream: () => ({
    sendMessage: mockSendMessage,
    isStreaming: mockIsStreaming,
    isConnecting: mockIsConnecting,
    error: null,
  }),
}));

vi.mock("../../src/services/api", () => ({
  apiClient: {
    chat: {
      listSessions: vi.fn().mockResolvedValue([]),
      getSessionDetail: vi.fn().mockResolvedValue({ session: {}, messages: [] }),
      createSession: vi.fn(),
      deleteSession: vi.fn(),
      updateSessionTitle: vi.fn().mockResolvedValue(undefined),
      generateSmartTitle: vi.fn().mockResolvedValue({ title: "test" }),
      streamUrl: vi.fn(),
      parseMessage: vi.fn(),
    },
    config: {
      getModels: vi.fn().mockResolvedValue({ models: { chat: ["qwen-max"] } }),
    },
    memory: {
      getFacts: vi.fn().mockResolvedValue({ items: [] }),
    },
  },
}));

const mockStartExtraction = vi.fn();
const mockResetExtraction = vi.fn();
let mockExtractionStatus = "idle";
let mockFacts: unknown[] = [];
let mockHasConflicted = false;

vi.mock("../../src/hooks/useMemoryExtraction", () => ({
  useMemoryExtraction: () => ({
    status: mockExtractionStatus,
    facts: mockFacts,
    hasConflicted: mockHasConflicted,
    startExtraction: mockStartExtraction,
    reset: mockResetExtraction,
  }),
}));

vi.mock("../../src/memory/MemoryFactsPanel", () => ({
  MemoryFactsPanel: ({ facts, hasConflicted }: { facts: unknown[]; hasConflicted: boolean }) => (
    <div data-testid="memory-facts-panel">
      facts={facts.length} conflicted={String(hasConflicted)}
    </div>
  ),
}));

// Mock child components to keep tests focused
vi.mock("../../src/chat/ChatSidebar", () => ({
  ChatSidebar: () => <div data-testid="chat-sidebar" />,
}));

vi.mock("../../src/chat/ChatInput", () => ({
  ChatInput: () => <div data-testid="chat-input" />,
}));

vi.mock("../../src/chat/ChatMessages", () => ({
  ChatMessages: () => <div data-testid="chat-messages" />,
}));

import { useChatStore } from "../../src/stores/useChatStore";
import { ChatView } from "../../src/chat/ChatView";

function setSession(id: string | null) {
  if (id) {
    useChatStore.setState({
      currentSessionId: id,
      sessions: [{ id, title: "Test", createdAt: new Date(), updatedAt: new Date() }],
    });
  } else {
    useChatStore.setState({ currentSessionId: null, sessions: [] });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExtractionStatus = "idle";
  mockFacts = [];
  mockHasConflicted = false;
  mockIsStreaming = false;
  mockIsConnecting = false;
  useChatStore.getState().reset();
});

afterEach(cleanup);

describe("ChatView — memory extraction button", () => {
  it('renders "记忆提取" button in the chat header', () => {
    setSession("s1");
    render(<ChatView />);
    const btn = screen.getByRole("button", { name: /记忆提取/ });
    expect(btn).toBeInTheDocument();
  });

  it("disables button when no session is selected", () => {
    setSession(null);
    render(<ChatView />);
    const btn = screen.getByRole("button", { name: /记忆提取/ });
    expect(btn).toBeDisabled();
  });

  it("disables button when streaming", () => {
    setSession("s1");
    mockIsStreaming = true;
    render(<ChatView />);
    const btn = screen.getByRole("button", { name: /记忆提取/ });
    expect(btn).toBeDisabled();
  });

  it('shows "提取中..." and disables button when extraction is in progress', () => {
    setSession("s1");
    mockExtractionStatus = "extracting";
    render(<ChatView />);
    const btn = screen.getByRole("button", { name: /提取中/ });
    expect(btn).toBeDisabled();
    expect(btn.textContent).toBe("提取中...");
  });

  it("calls startExtraction with current session ID when button is clicked", () => {
    setSession("s1");
    render(<ChatView />);
    const btn = screen.getByRole("button", { name: /记忆提取/ });
    fireEvent.click(btn);
    expect(mockStartExtraction).toHaveBeenCalledWith("s1");
  });

  it("resets extraction state when session changes", () => {
    setSession("s1");
    useChatStore.setState({
      sessions: [
        { id: "s1", title: "A", createdAt: new Date(), updatedAt: new Date() },
        { id: "s2", title: "B", createdAt: new Date(), updatedAt: new Date() },
      ],
    });

    render(<ChatView />);

    // resetExtraction is called on mount due to the useEffect
    expect(mockResetExtraction).toHaveBeenCalled();
    mockResetExtraction.mockClear();

    // Change session
    act(() => {
      useChatStore.setState({ currentSessionId: "s2" });
    });

    expect(mockResetExtraction).toHaveBeenCalled();
  });

  it("renders MemoryFactsPanel when extraction status is done", () => {
    setSession("s1");
    mockExtractionStatus = "done";
    mockFacts = [{ id: "f1" }];
    mockHasConflicted = true;
    render(<ChatView />);
    expect(screen.getByTestId("memory-facts-panel")).toBeInTheDocument();
  });

  it("does not render MemoryFactsPanel when extraction status is idle", () => {
    setSession("s1");
    mockExtractionStatus = "idle";
    render(<ChatView />);
    expect(screen.queryByTestId("memory-facts-panel")).not.toBeInTheDocument();
  });
});
