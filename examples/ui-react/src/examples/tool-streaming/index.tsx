import { useCallback } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Globe } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";
import { ToolProgressCard } from "./components/ToolProgressCard";

const TOOL_STREAMING_SUGGESTIONS = [
  "Plan a trip to Tokyo for 3 days",
  "Find flights and hotels in Barcelona for 5 days",
  "Plan a week in Paris with focus on food and history",
  "Search for flights to New York next Friday",
];

function hasContent(message: Message): boolean {
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

export function ToolStreaming() {
  const stream = useStream<typeof agent>({
    assistantId: "tool-streaming",
    apiUrl: "http://localhost:2024",
  });

  const { scrollRef, contentRef } = useStickToBottom();

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" } as any] });
    },
    [stream]
  );

  const hasMessages = stream.messages.length > 0;

  const activeProgress = stream.toolProgress.filter(
    (tp) => tp.state === "starting" || tp.state === "running"
  );

  const lastMessage = stream.messages[stream.messages.length - 1];
  const waitingForFirstResponse = lastMessage?.type === "human";
  const hasAiContent = stream.messages.some(
    (m) => m.type === "ai" && hasContent(m)
  );
  const showLoading =
    (stream.isLoading || waitingForFirstResponse) &&
    activeProgress.length === 0 &&
    !hasAiContent;

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Globe}
              title="Tool Streaming"
              description="Watch tools stream progress in real-time as they search flights, check hotels, and plan itineraries. Powered by the tools stream mode."
              suggestions={TOOL_STREAMING_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => (
                <MessageBubble key={message.id ?? idx} message={message} />
              ))}

              {activeProgress.map((tp) => (
                <ToolProgressCard
                  key={tp.toolCallId ?? tp.name}
                  toolProgress={tp}
                />
              ))}

              {showLoading && <LoadingIndicator />}
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
        placeholder="Ask me to plan a trip..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

registerExample({
  id: "tool-streaming",
  title: "Tool Streaming",
  description:
    "Stream tool progress with real-time updates using the tools stream mode",
  category: "advanced",
  icon: "tool",
  ready: true,
  component: ToolStreaming,
});

export default ToolStreaming;
