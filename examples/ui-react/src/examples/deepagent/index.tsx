import { useCallback, useMemo, useState, useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Plane, Sparkles } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { SubagentPipeline } from "./components/SubagentPipeline";

import type { agent } from "./agent";

const VACATION_SUGGESTIONS = [
  "Plan a romantic getaway to Paris for 2 people, 5 nights, midrange budget",
  "Family vacation to Tokyo with 4 people for a week, budget-friendly",
  "Adventure trip to Costa Rica for 2, focusing on nature and wildlife",
  "Weekend city break to Barcelona in spring",
];

/**
 * Helper to check if a message has actual text content
 */
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

/**
 * Custom hook to manage thread ID in URL search params
 */
function useThreadIdParam() {
  const [threadId, setThreadId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    return params.get("threadId");
  });

  const updateThreadId = useCallback((newThreadId: string | null) => {
    setThreadId(newThreadId);

    const url = new URL(window.location.href);
    if (newThreadId == null) {
      url.searchParams.delete("threadId");
    } else {
      url.searchParams.set("threadId", newThreadId);
    }
    window.history.replaceState({}, "", url.toString());
  }, []);

  return [threadId, updateThreadId] as const;
}

export function DeepAgentDemo() {
  const { scrollRef, contentRef } = useStickToBottom();
  const [pipelineShown, setPipelineShown] = useState(false);
  const [threadId, onThreadId] = useThreadIdParam();

  // Use filterSubagentMessages to keep main messages clean
  // Subagent messages are accessible via stream.subagents.get(id).messages
  const stream = useStream<typeof agent>({
    assistantId: "deepagent",
    apiUrl: "http://localhost:2024",
    filterSubagentMessages: true,
    threadId,
    onThreadId,
    // Enable automatic stream reconnection after page refresh
    reconnectOnMount: true,
  });

  const hasMessages = stream.messages.length > 0;
  const hasSubagents = stream.subagents.size > 0;

  // Reset pipeline shown state when messages are cleared
  useEffect(() => {
    if (!hasMessages && !hasSubagents) {
      setPipelineShown(false);
    }
  }, [hasMessages, hasSubagents]);

  // Mark pipeline as shown when we have subagents
  useEffect(() => {
    if (hasSubagents && !pipelineShown) {
      setPipelineShown(true);
    }
  }, [hasSubagents, pipelineShown]);

  // Check if we're in the synthesis phase (subagents done, waiting for final response)
  const allSubagentsDone =
    hasSubagents &&
    [...stream.subagents.values()].every(
      (s) => s.status === "complete" || s.status === "error"
    );

  // Filter messages: only show human messages and AI messages with actual content
  // Tool messages and AI messages that only have tool_calls are hidden
  const displayMessages = useMemo(() => {
    return stream.messages.filter((message) => {
      // Always show human messages
      if (message.type === "human") return true;

      // Hide tool messages (they're shown in subagent cards)
      if (message.type === "tool") return false;

      // For AI messages, only show if they have actual content
      if (message.type === "ai") {
        // Hide AI messages that only contain tool_calls (no text content)
        if ("tool_calls" in message && message.tool_calls?.length) {
          return hasContent(message);
        }
        return hasContent(message);
      }

      return false;
    });
  }, [stream.messages]);

  const handleSubmit = useCallback(
    (content: string) => {
      setPipelineShown(false);
      stream.submit(
        { messages: [{ content, type: "human" }] },
        {
          streamSubgraphs: true,
          config: {
            recursion_limit: 100,
          },
        }
      );
    },
    [stream]
  );

  // Determine where to show pipeline (after the last human message)
  const humanMessageIndex = useMemo(() => {
    for (let i = displayMessages.length - 1; i >= 0; i--) {
      if (displayMessages[i].type === "human") {
        return i;
      }
    }
    return -1;
  }, [displayMessages]);

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-6xl mx-auto px-8 py-8">
          {!hasMessages && !hasSubagents ? (
            <EmptyState
              icon={Plane}
              title="Dream Vacation Planner"
              description="Tell me where you want to go, and I'll coordinate three specialist agents to plan your perfect trip: a Weather Scout, an Experience Curator, and a Budget Optimizer - all working in parallel!"
              suggestions={VACATION_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {displayMessages.map((message, idx) => (
                <div key={message.id ?? `msg-${idx}`}>
                  <MessageBubble message={message} />

                  {/* Show pipeline right after the human message */}
                  {idx === humanMessageIndex &&
                    pipelineShown &&
                    hasSubagents && (
                      <div className="mt-6">
                        <SubagentPipeline
                          subagents={stream.subagents}
                          isLoading={stream.isLoading && !allSubagentsDone}
                        />
                      </div>
                    )}
                </div>
              ))}

              {stream.values.todos && stream.values.todos.length > 0 && (
                <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-md bg-brand-accent/15 flex items-center justify-center">
                        <Sparkles className="w-4 h-4 text-brand-accent" />
                      </div>
                      <div>
                        <h4 className="text-sm font-medium text-neutral-200">
                          Deep Agent Todos
                        </h4>
                        <p className="text-xs text-neutral-500">
                          {stream.values.todos.length} active
                        </p>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    {stream.values.todos.map((todo, idx) => {
                      return (
                        <div
                          key={`todo-${idx}`}
                          className="flex items-start gap-3 rounded-lg border border-neutral-800 bg-neutral-950/40 px-3 py-2 text-sm"
                        >
                          <div className="mt-1 h-2 w-2 rounded-full bg-brand-accent/70" />
                          <div className="flex-1 text-neutral-200">
                            <div>{todo.content}</div>
                            <div className="text-xs text-neutral-500 mt-1">
                              Status: {todo.status}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Show pipeline if we have subagents but no display messages yet */}
              {displayMessages.length === 0 &&
                pipelineShown &&
                hasSubagents && (
                  <SubagentPipeline
                    subagents={stream.subagents}
                    isLoading={stream.isLoading && !allSubagentsDone}
                  />
                )}

              {/* Show loading indicator when waiting for initial response */}
              {stream.isLoading && !hasSubagents && !pipelineShown && (
                <LoadingIndicator />
              )}

              {/* Show synthesis indicator when subagents are done but still loading */}
              {stream.isLoading && allSubagentsDone && (
                <div className="flex items-center gap-3 text-brand-accent/70 animate-pulse">
                  <Sparkles className="w-5 h-5" />
                  <span className="text-sm">
                    Synthesizing your personalized vacation plan...
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-6xl mx-auto px-4 pb-3">
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
        placeholder="Where would you like to go? (e.g., 'Plan a trip to Japan for 2 people')"
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "deepagent",
  title: "Deep Agent (Subagents)",
  description:
    "Watch 3 specialized AI agents plan your vacation in parallel with live streaming",
  category: "agents",
  icon: "tool",
  ready: true,
  component: DeepAgentDemo,
});

export default DeepAgentDemo;
