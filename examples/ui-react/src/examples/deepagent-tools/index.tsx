import { useCallback, useMemo, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Layers, Sparkles } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";
import { SubagentPipeline } from "./components/SubagentPipeline";

import type { agent } from "./agent";

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

export function DeepAgentToolsDemo() {
  const { scrollRef, contentRef } = useStickToBottom();
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

  // Build a map of human message ID -> subagents for that turn.
  // With filterSubagentMessages enabled, each turn follows a predictable
  // pattern: Human -> AI (with tool_calls) -> Tool(s) -> AI (synthesis).
  const subagentsByHumanMessage = useMemo(() => {
    const result = new Map<
      string,
      ReturnType<typeof stream.getSubagentsByMessage>
    >();
    const msgs = stream.messages;

    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].type !== "human") continue;

      // The next message in the turn is the AI message with tool_calls
      const next = msgs[i + 1];
      if (!next || next.type !== "ai" || !next.id) continue;

      const subagents = stream.getSubagentsByMessage(next.id);
      if (subagents.length > 0) {
        result.set(msgs[i].id!, subagents);
      }
    }
    return result;
  }, [stream.messages, stream.subagents]);

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
              {displayMessages.map((message, idx) => {
                const messageKey = message.id ?? `msg-${idx}`;
                const turnSubagents =
                  message.type === "human"
                    ? subagentsByHumanMessage.get(messageKey)
                    : undefined;

                return (
                  <div key={messageKey}>
                    <MessageBubble message={message} />

                    {/* Show pipeline right after the human message that triggered it */}
                    {turnSubagents && turnSubagents.length > 0 && (
                      <div className="mt-6">
                        <SubagentPipeline
                          subagents={turnSubagents}
                          isLoading={stream.isLoading && !allSubagentsDone}
                        />
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Show loading indicator when waiting for initial response */}
              {stream.isLoading && !hasSubagents && <LoadingIndicator />}

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
