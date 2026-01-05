import { useCallback } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Brain } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";
import { MessageBubble } from "../../components/MessageBubble";

import type { agent } from "./agent";

const REASONING_SUGGESTIONS = [
  "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost?",
  "If it takes 5 machines 5 minutes to make 5 widgets, how long would it take 100 machines to make 100 widgets?",
];

export function ReasoningAgent() {
  const stream = useStream<typeof agent>({
    assistantId: "reasoning-agent",
    apiUrl: "http://localhost:2024",
  });

  const { scrollRef, contentRef } = useStickToBottom();

  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Brain}
              title="Reasoning Agent"
              description="Watch the model think through complex problems with extended reasoning. The thinking process is streamed to a separate bubble in real-time, showing you how the AI arrives at its conclusions."
              suggestions={REASONING_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => (
                <MessageBubble key={message.id ?? idx} message={message} />
              ))}

              {/* Show loading indicator when streaming and no content yet, e.g. we don't have a stream of the AI response yet */}
              {stream.isLoading && stream.messages.length <= 2 && (
                <div className="flex items-center gap-3 text-amber-400/70">
                  <LoadingIndicator />
                  <span className="text-sm">Thinking...</span>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-2xl mx-auto px-4 pb-3">
          <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-red-400 text-sm">
            <div className="flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred. Make sure OPENAI_API_KEY is set."}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading}
        placeholder="Ask a complex reasoning question..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "reasoning-agent",
  title: "Reasoning Agent",
  description: "Streaming reasoning tokens to a separate bubble in real-time",
  category: "advanced",
  icon: "code",
  ready: true,
  component: ReasoningAgent,
});

export default ReasoningAgent;
