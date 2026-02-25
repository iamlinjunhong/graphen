import { ArrowUp } from "lucide-react";
import { useRef, useState } from "react";

interface ChatInputProps {
  disabled?: boolean;
  isStreaming: boolean;
  models: string[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  onSend: (content: string) => Promise<void>;
}

export function ChatInput({
  disabled,
  isStreaming,
  onSend
}: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  /** Auto-grow textarea height based on content */
  function autoGrow(el: HTMLTextAreaElement) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }

  const submit = async () => {
    const content = input.trim();
    if (content.length === 0 || disabled || isStreaming) {
      return;
    }
    setInput("");
    // reset height after clear
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    await onSend(content);
  };

  const canSend = input.trim().length > 0 && !disabled && !isStreaming;

  return (
    <section className="chat-input-panel">
      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(event) => {
            setInput(event.currentTarget.value);
            autoGrow(event.currentTarget);
          }}
          disabled={disabled || isStreaming}
          placeholder="输入您的问题，按回车发送..."
          rows={1}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="chat-send-button"
          disabled={!canSend}
          onClick={() => {
            void submit();
          }}
          aria-label="Send message"
        >
          <ArrowUp size={16} strokeWidth={2.5} />
        </button>
      </div>
    </section>
  );
}
