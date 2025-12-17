import { StrictMode, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";

import { useStream } from "@langchain/langgraph-sdk/react";
import type { UIMessage } from "@langchain/langgraph-sdk";

import type { agent } from "./agent";

import { LoadingIndicator } from "./components/Loading";
import { EmptyState } from "./components/States";
import { MessageBubble } from "./components/MessageBubble";
import { ToolCallCard } from "./components/ToolCallCard";

/**
 * Helper to check if a message has actual text content.
 */
function hasContent(message: UIMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length > 0;
  }
  if (Array.isArray(message.content)) {
    return message.content.some(
      (c) => c.type === "text" && c.text.trim().length > 0
    );
  }
  return false;
}

export function App() {
  const stream = useStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stream.uiMessages, stream.isLoading]);

  // Auto-resize textarea
  const handleTextareaInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const target = e.target as HTMLTextAreaElement;
    target.style.height = "auto";
    target.style.height = `${Math.min(target.scrollHeight, 200)}px`;
  };

  const hasMessages = stream.uiMessages.length > 0;

  return (
    <div className="min-h-screen bg-black flex flex-col">
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.uiMessages.map((message, idx) => {
                // For AI messages, check if they have tool calls
                if (message.type === "ai") {
                  const toolCalls = stream.getToolCalls(message);

                  // Render tool calls if present
                  if (toolCalls.length > 0) {
                    return (
                      <div key={message.id} className="flex flex-col gap-3">
                        {toolCalls.map((toolCall) => (
                          <ToolCallCard key={toolCall.id} toolCall={toolCall} />
                        ))}
                      </div>
                    );
                  }

                  // Skip AI messages without content
                  if (!hasContent(message)) {
                    return null;
                  }
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Show loading indicator when streaming and no content yet */}
              {stream.isLoading &&
                !stream.uiMessages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                stream.toolCalls.length === 0 && <LoadingIndicator />}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <svg
                className="w-4 h-4 flex-shrink-0"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <footer className="border-t border-neutral-800">
        <div className="max-w-2xl mx-auto px-4 py-4">
          <form
            className="relative"
            onSubmit={(e) => {
              e.preventDefault();

              const form = e.target as HTMLFormElement;
              const formData = new FormData(form);
              const content = formData.get("content") as string;

              if (!content.trim()) return;

              form.reset();
              if (textareaRef.current) {
                textareaRef.current.style.height = "auto";
              }
              stream.submit({ messages: [{ content, type: "human" }] });
            }}
          >
            <div className="relative bg-neutral-900 rounded-xl border border-neutral-800 focus-within:border-neutral-700 transition-colors">
              <textarea
                ref={textareaRef}
                name="content"
                placeholder="Send a message..."
                rows={1}
                disabled={stream.isLoading}
                className="w-full bg-transparent text-white placeholder-neutral-500 px-4 py-3 pr-12 resize-none focus:outline-none text-sm leading-relaxed max-h-[200px] disabled:opacity-50"
                onInput={handleTextareaInput}
                onKeyDown={(e) => {
                  const target = e.target as HTMLTextAreaElement;

                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    target.form?.requestSubmit();
                  }
                }}
              />

              <button
                type="submit"
                disabled={stream.isLoading}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg bg-white hover:bg-neutral-200 disabled:bg-neutral-700 disabled:cursor-not-allowed text-black disabled:text-neutral-500 transition-colors"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M5 10l7-7m0 0l7 7m-7-7v18"
                  />
                </svg>
              </button>
            </div>

            <p className="text-center text-xs text-neutral-600 mt-3">
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono text-[10px]">
                Enter
              </kbd>{" "}
              to send ·{" "}
              <kbd className="px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400 font-mono text-[10px]">
                Shift + Enter
              </kbd>{" "}
              for new line
            </p>
          </form>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
