import { useEffect, useRef } from "react";
import { Zap } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ChatMessage, ChatSource } from "@graphen/shared";
import { ChatSourceCard } from "./ChatSourceCard";
import { ChatPathCard } from "./ChatPathCard";

interface ChatMessagesProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingMessage: string;
  onOpenDocument: (source: ChatSource) => void;
  onOpenGraph: (source: ChatSource) => void;
  onGraphNodeClick: (nodeName: string) => void;
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
  onOpenGraph,
  onGraphNodeClick
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, isStreaming, streamingMessage]);

  return (
    <section className="chat-messages-panel" aria-label="Chat messages">
      <div className="chat-message-list">
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
                  <div className="chat-markdown-content">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>
                      {message.content}
                    </ReactMarkdown>
                  </div>

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

                  {/* Reasoning paths */}
                  {isAssistant && message.sourcePaths && message.sourcePaths.length > 0 ? (
                    <div className="chat-path-list" style={{ marginTop: "10px" }}>
                      <small className="chat-path-list-label">推理路径</small>
                      {message.sourcePaths.map((path, idx) => (
                        <ChatPathCard
                          key={`${message.id}:path:${idx}`}
                          path={path}
                          onNodeClick={onGraphNodeClick}
                        />
                      ))}
                    </div>
                  ) : null}

                  {/* Inferred relations (T18) */}
                  {isAssistant && message.inferredRelations && message.inferredRelations.length > 0 ? (
                    <div className="chat-inferred-list" style={{ marginTop: "10px" }}>
                      <small className="chat-path-list-label">推断关系</small>
                      {message.inferredRelations.map((rel, idx) => (
                        <div key={`${message.id}:infer:${idx}`} className="chat-inferred-card">
                          <span className="chat-inferred-triple">
                            <button type="button" className="chat-path-node" onClick={() => onGraphNodeClick(rel.source)}>
                              {rel.source}
                            </button>
                            <span className="chat-path-relation">--[{rel.relationType}]--&gt;</span>
                            <button type="button" className="chat-path-node" onClick={() => onGraphNodeClick(rel.target)}>
                              {rel.target}
                            </button>
                          </span>
                          <span className="chat-inferred-meta">
                            置信度 {rel.confidence.toFixed(2)} · {rel.reasoning}
                          </span>
                        </div>
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
                <div className="chat-markdown-content">
                  {streamingMessage.length > 0 ? (
                    <>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {streamingMessage}
                      </ReactMarkdown>
                      <span className="chat-cursor">|</span>
                    </>
                  ) : (
                    <p>思考中...</p>
                  )}
                </div>
              </div>
            </div>
          </article>
        ) : null}

        <div ref={messagesEndRef} />
      </div>
    </section>
  );
}
