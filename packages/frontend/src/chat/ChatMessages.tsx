import { Zap } from "lucide-react";
import type { ChatMessage, ChatSource } from "@graphen/shared";
import { ChatSourceCard } from "./ChatSourceCard";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingMessage: string;
  onOpenDocument: (source: ChatSource) => void;
  onOpenGraph: (source: ChatSource) => void;
}

function formatMessageTime(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

export function ChatMessages({
  messages,
  isStreaming,
  streamingMessage,
  onOpenDocument,
  onOpenGraph
}: ChatMessagesProps) {
  return (
    <section className="chat-messages-panel" aria-label="Chat messages">
      <div className="chat-message-list">
        {messages.length === 0 && !isStreaming ? (
          <p className="muted" style={{ padding: "24px 0", textAlign: "center" }}>
            No messages yet. Start a conversation!
          </p>
        ) : null}

        {messages.map((message) => {
          const isAssistant = message.role === "assistant";

          return (
            <article
              key={message.id}
              className={isAssistant ? "chat-message-card is-assistant" : "chat-message-card is-user"}
            >
              {/* Avatar */}
              <span className={isAssistant ? "message-icon" : "message-icon user-avatar-icon"}>
                {isAssistant ? <Zap size={15} strokeWidth={2.5} /> : "L"}
              </span>

              {/* Body */}
              <div className="chat-message-body">
                <div className="chat-message-bubble">
                  <p>{message.content}</p>

                  {/* Source citations */}
                  {isAssistant && message.sources && message.sources.length > 0 ? (
                    <div className="chat-source-list" style={{ marginTop: "12px" }}>
                      {message.sources.map((source) => (
                        <ChatSourceCard
                          key={`${message.id}:${source.chunkId}`}
                          source={source}
                          onOpenDocument={onOpenDocument}
                          onOpenGraph={onOpenGraph}
                        />
                      ))}
                    </div>
                  ) : null}
                </div>

                <small>{formatMessageTime(message.createdAt)}</small>
              </div>
            </article>
          );
        })}

        {/* Streaming indicator */}
        {isStreaming ? (
          <article className="chat-message-card is-assistant is-streaming">
            <span className="message-icon">
              <Zap size={15} strokeWidth={2.5} />
            </span>
            <div className="chat-message-body">
              <div className="chat-message-bubble">
                <p>
                  {streamingMessage.length > 0 ? streamingMessage : "思考中..."}
                  {streamingMessage.length > 0 ? <span className="chat-cursor">|</span> : null}
                </p>
              </div>
            </div>
          </article>
        ) : null}
      </div>
    </section>
  );
}
