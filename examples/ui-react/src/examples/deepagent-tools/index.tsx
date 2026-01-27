import { useCallback, useMemo, useState, useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Layers, Sparkles, Loader2 } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { SubagentStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { SubagentStreamCard } from "./components/SubagentStreamCard";

import type { agent } from "./agent";
import type { SubagentType } from "./types";

const EXAMPLE_SUGGESTIONS = [
  "Research the current state of AI in healthcare and create a summary report",
  "Analyze market trends for electric vehicles and draft key findings",
  "Gather information about sustainable energy and present the data",
  "Research remote work productivity studies and write a brief analysis",
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

/**
 * Sort subagents by type for consistent display order
 */
const SORT_ORDER: SubagentType[] = [
  "researcher",
  "data-analyst",
  "content-writer",
];

function sortSubagents(
  subagents: Map<string, SubagentStream>
): SubagentStream[] {
  return [...subagents.values()].sort((a, b) => {
    const aType = (a.toolCall?.args?.subagent_type as SubagentType) || "";
    const bType = (b.toolCall?.args?.subagent_type as SubagentType) || "";
    const aIndex = SORT_ORDER.indexOf(aType);
    const bIndex = SORT_ORDER.indexOf(bType);
    return (aIndex === -1 ? 999 : aIndex) - (bIndex === -1 ? 999 : bIndex);
  });
}

/**
 * Pipeline visualization showing all subagents with their tool calls
 */
function SubagentPipeline({
  subagents,
  isLoading,
}: {
  subagents: Map<string, SubagentStream>;
  isLoading: boolean;
}) {
  const sortedSubagents = useMemo(() => sortSubagents(subagents), [subagents]);

  if (sortedSubagents.length === 0) {
    return null;
  }

  const completedCount = sortedSubagents.filter(
    (s) => s.status === "complete"
  ).length;
  const totalCount = sortedSubagents.length;

  // Count total tool calls across all subagents
  const totalToolCalls = sortedSubagents.reduce(
    (acc, s) => acc + s.toolCalls.length,
    0
  );

  return (
    <div className="mb-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-brand-accent/20 flex items-center justify-center">
            <Layers className="w-4 h-4 text-brand-accent" />
          </div>
          <div>
            <h3 className="font-medium text-neutral-200">Subagent Pipeline</h3>
            <p className="text-xs text-neutral-500">
              {completedCount}/{totalCount} agents • {totalToolCalls} tool calls
            </p>
          </div>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 text-brand-accent text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Agents working...</span>
          </div>
        )}
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-neutral-800 rounded-full mb-4 overflow-hidden">
        <div
          className="h-full bg-linear-to-r from-blue-500 via-purple-500 to-rose-500 transition-all duration-500"
          style={{ width: `${(completedCount / totalCount) * 100}%` }}
        />
      </div>

      {/* Subagent Cards - Vertical Stack for better tool call visibility */}
      <div className="space-y-4">
        {sortedSubagents.map((subagent) => (
          <SubagentStreamCard
            key={subagent.id}
            subagent={subagent}
            defaultExpanded={
              subagent.status === "running" || subagent.toolCalls.length > 0
            }
          />
        ))}
      </div>
    </div>
  );
}

export function DeepAgentToolsDemo() {
  const { scrollRef, contentRef } = useStickToBottom();
  const [pipelineShown, setPipelineShown] = useState(false);
  const [threadId, onThreadId] = useThreadIdParam();

  // Use filterSubagentMessages to keep main messages clean
  // Subagent messages and tool calls are accessible via stream.subagents
  const stream = useStream<typeof agent>({
    assistantId: "deepagent-tools",
    apiUrl: "http://localhost:2024",
    filterSubagentMessages: true,
    threadId,
    onThreadId,
    // Enable automatic stream reconnection after page refresh
    reconnectOnMount: true,
    onError: (error) => {
      console.error("Stream error:", error);
    },
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
  const displayMessages = useMemo(() => {
    return stream.messages.filter((message) => {
      if (message.type === "human") return true;
      if (message.type === "tool") return false;
      if (message.type === "ai") {
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
        <div ref={contentRef} className="max-w-4xl mx-auto px-8 py-8">
          {!hasMessages && !hasSubagents ? (
            <EmptyState
              icon={Layers}
              title="Deep Agent with Tools"
              description="Watch specialized subagents work on your task, each using their own tools. You'll see the research, analysis, and writing happen in real-time with full tool call visibility."
              suggestions={EXAMPLE_SUGGESTIONS}
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
                    Synthesizing results from all agents...
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {stream.error != null && (
        <div className="max-w-4xl mx-auto px-4 pb-3">
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
        placeholder="Ask me to research, analyze, or write something..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "deepagent-tools",
  title: "Deep Agent with Tools",
  description:
    "Subagents with their own tools - see tool calls streaming in real-time",
  category: "agents",
  icon: "tool",
  ready: true,
  component: DeepAgentToolsDemo,
});

export default DeepAgentToolsDemo;
