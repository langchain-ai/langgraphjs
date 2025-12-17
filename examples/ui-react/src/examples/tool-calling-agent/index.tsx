import { useRef, useEffect, useCallback } from "react";
import { AlertCircle, Wrench } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { UIMessage } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { ToolCallCard } from "../../components/ToolCallCard";

import type { agent } from "./agent";

const TOOL_AGENT_SUGGESTIONS = [
  "What's the weather in San Francisco?",
  "Search for the latest AI news",
  "What's the weather in Tokyo?",
];

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

export function ToolCallingAgent() {
  const stream = useStream<typeof agent>({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stream.uiMessages, stream.isLoading]);

  const hasMessages = stream.uiMessages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  return (
    <div className="h-full flex flex-col">
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Wrench}
              title="Tool Calling Agent"
              description="A smart agent with weather and search tools. Ask about the weather anywhere or search for information."
              suggestions={TOOL_AGENT_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
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
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              <span>
                {stream.error instanceof Error
                  ? stream.error.message
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading}
        placeholder="Ask me about weather or search for info..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "tool-calling-agent",
  title: "Tool Calling Agent",
  description:
    "Simple agent with weather and search tools demonstrating streaming tool calls",
  category: "agents",
  icon: "tool",
  ready: true,
  component: ToolCallingAgent,
});

export default ToolCallingAgent;
