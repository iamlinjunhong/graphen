import { MessageSquare, PenSquare, Search, Trash2 } from "lucide-react";
import type { ChatSession } from "@graphen/shared";

interface ChatSidebarProps {
  sessions: ChatSession[];
  currentSessionId: string | null;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onCreateSession: () => Promise<void>;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (session: ChatSession) => Promise<void>;
}

function formatTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function ChatSidebar({
  sessions,
  currentSessionId,
  searchQuery,
  onSearchChange,
  onCreateSession,
  onSelectSession,
  onDeleteSession
}: ChatSidebarProps) {
  return (
    <aside className="side-panel chat-sidebar">
      {/* Search + New button row */}
      <div className="side-search-row">
        <div className="side-search-wrap">
          <span className="search-icon">
            <Search size={14} />
          </span>
          <input
            className="side-search-input"
            value={searchQuery}
            onChange={(event) => onSearchChange(event.currentTarget.value)}
            placeholder="Search chats..."
            aria-label="Search chat sessions"
          />
        </div>
        <button
          type="button"
          className="icon-action-button"
          title="New Chat"
          onClick={() => {
            void onCreateSession();
          }}
          aria-label="New session"
        >
          <PenSquare size={16} />
        </button>
      </div>

      {/* Section label */}
      <p className="chat-sidebar-section-label" style={{ padding: "0 1.5rem", marginBottom: "10px" }}>
        Recent Conversations
      </p>

      {/* Session list */}
      <div className="chat-session-list" style={{ padding: "0 1rem" }}>
        {sessions.length === 0 ? (
          <p className="muted" style={{ padding: "8px 4px", fontSize: "0.875rem" }}>
            No sessions yet
          </p>
        ) : null}

        {sessions.map((session) => (
          <div
            key={session.id}
            className="chat-session-item"
            data-selected={session.id === currentSessionId}
          >
            <MessageSquare
              size={15}
              strokeWidth={2}
              className="chat-session-icon"
            />
            <button
              type="button"
              className="chat-session-main"
              onClick={() => onSelectSession(session.id)}
            >
              <span className="chat-session-title">{session.title}</span>
              <span className="chat-session-time">{formatTime(session.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="chat-delete-button"
              onClick={() => {
                void onDeleteSession(session);
              }}
              aria-label={`Delete ${session.title}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
