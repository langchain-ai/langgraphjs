import { useEffect, useCallback, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  Sparkles,
  MessageSquare,
  Layers,
  Zap,
  RefreshCw,
} from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";
import { ToolCallCard } from "../../components/ToolCallCard";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";
import { getPrefilledMessages } from "./prefilled-messages";

/**
 * Extract text content from a message
 */
function getContent(message: Message): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

/**
 * Check if a message is a summary message
 */
function isSummaryMessage(message: Message): boolean {
  const content = getContent(message);
  return (
    content.includes("📋 **Conversation Summary:**") ||
    content.includes("Conversation Summary:") ||
    content.toLowerCase().includes("summary of our conversation")
  );
}

/**
 * Toast notification for summarization events
 */
function SummarizationToast({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed top-24 right-4 z-100 animate-fade-in">
      <div className="bg-neutral-900/95 backdrop-blur-md border border-violet-500/40 rounded-xl px-4 py-3 shadow-2xl shadow-violet-500/10 flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
          <Layers className="w-4 h-4 text-violet-400" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-medium text-violet-200 flex items-center gap-1.5">
            Conversation Summarized
            <Sparkles className="w-3.5 h-3.5 text-fuchsia-400" />
          </div>
          <p className="text-xs text-neutral-400">
            Older messages condensed to maintain context
          </p>
        </div>
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-300 transition-colors p-1"
        >
          <svg
            className="w-4 h-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}

/**
 * Summary message card with special styling
 */
function SummaryMessageCard({ message }: { message: Message }) {
  const content = getContent(message);

  return (
    <div className="bg-linear-to-br from-violet-950/40 to-fuchsia-950/30 border border-violet-500/20 rounded-xl p-5 animate-fade-in">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-8 h-8 rounded-lg bg-violet-500/20 border border-violet-500/30 flex items-center justify-center shrink-0">
          <Layers className="w-4 h-4 text-violet-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-violet-400 mb-1 flex items-center gap-1">
            <span>Summarized Context</span>
            <Sparkles className="w-3 h-3 text-fuchsia-400" />
          </div>
          <div className="text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
            {content.replace(/📋 \*\*Conversation Summary:\*\*\n\n?/, "")}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Regular message bubble with type-aware styling
 */
function MessageBubble({ message }: { message: Message }) {
  const isHuman = message.type === "human";
  const content = getContent(message);

  if (!content) return null;

  // Check if this is a summary message
  if (!isHuman && isSummaryMessage(message)) {
    return <SummaryMessageCard message={message} />;
  }

  return (
    <div className="animate-fade-in">
      {!isHuman && (
        <div className="text-xs font-medium text-neutral-500 mb-2 flex items-center gap-1">
          <MessageSquare className="w-3 h-3" />
          <span>Assistant</span>
        </div>
      )}

      <div
        className={`${
          isHuman
            ? "bg-brand-dark text-brand-light rounded-2xl px-4 py-2.5 ml-auto max-w-[85%] md:max-w-[70%] w-fit"
            : "text-neutral-100"
        }`}
      >
        <div className="whitespace-pre-wrap leading-relaxed text-[15px]">
          {content}
        </div>
      </div>
    </div>
  );
}

/**
 * Stats panel showing conversation metrics
 */
function ConversationStats({
  messageCount,
  hasSummary,
}: {
  messageCount: number;
  hasSummary: boolean;
}) {
  return (
    <div className="fixed right-6 top-1/2 -translate-y-1/2 z-50 bg-neutral-900/95 backdrop-blur-sm rounded-xl p-4 border border-neutral-800 shadow-xl w-52">
      <div className="text-xs text-neutral-500 uppercase tracking-wider mb-3 font-medium">
        Context Status
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">Messages</span>
          <span className="text-sm font-mono text-neutral-200">
            {messageCount}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-neutral-400">Status</span>
          <span
            className={`text-xs font-medium px-2 py-0.5 rounded-full ${
              hasSummary
                ? "bg-violet-500/20 text-violet-300"
                : messageCount >= 6
                ? "bg-amber-500/20 text-amber-300"
                : "bg-emerald-500/20 text-emerald-300"
            }`}
          >
            {hasSummary
              ? "Summarized"
              : messageCount >= 6
              ? "Near Limit"
              : "Normal"}
          </span>
        </div>

        {!hasSummary && messageCount >= 4 && (
          <div className="pt-2 border-t border-neutral-800">
            <div className="flex items-center gap-2 text-xs text-amber-400/80">
              <RefreshCw className="w-3 h-3" />
              <span>Summarization at ~8 messages</span>
            </div>
          </div>
        )}

        {hasSummary && (
          <div className="pt-2 border-t border-neutral-800">
            <div className="flex items-center gap-2 text-xs text-violet-400/80">
              <Sparkles className="w-3 h-3" />
              <span>Context has been compressed</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Empty state component
 */
function EmptyState({
  onPrefill,
  onSuggestionClick,
  isPrefilling,
}: {
  onPrefill: () => void;
  onSuggestionClick: (text: string) => void;
  isPrefilling: boolean;
}) {
  return (
    <div className="flex flex-col items-center justify-center h-full py-12">
      <div className="w-16 h-16 rounded-2xl bg-linear-to-br from-violet-500/20 to-fuchsia-500/20 border border-violet-500/30 flex items-center justify-center mb-6">
        <Layers className="w-8 h-8 text-violet-400" />
      </div>

      <h2 className="text-xl font-semibold text-white mb-2">
        Summarization Middleware Demo
      </h2>

      <p className="text-neutral-400 text-center max-w-md mb-8">
        See how the summarization middleware automatically condenses long
        conversations while preserving context. Start with a pre-filled
        conversation to trigger summarization.
      </p>

      <div className="flex flex-col gap-3 w-full max-w-sm">
        <button
          onClick={onPrefill}
          disabled={isPrefilling}
          className="flex items-center justify-center gap-2 px-6 py-3 rounded-xl bg-linear-to-r from-violet-600 to-fuchsia-600 hover:from-violet-500 hover:to-fuchsia-500 text-white font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isPrefilling ? (
            <>
              <LoadingIndicator />
              <span>Loading conversation...</span>
            </>
          ) : (
            <>
              <Zap className="w-4 h-4" />
              <span>Load Pre-filled Conversation</span>
            </>
          )}
        </button>

        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <div className="flex-1 h-px bg-neutral-800" />
          <span>or start fresh</span>
          <div className="flex-1 h-px bg-neutral-800" />
        </div>

        <div className="flex flex-wrap gap-2">
          {[
            "Tell me about Tokyo",
            "Help me plan a trip",
            "What's 1500 * 0.85?",
          ].map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestionClick(suggestion)}
              className="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-300 text-sm transition-colors"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function SummarizationAgent() {
  const stream = useStream<typeof agent>({
    assistantId: "summarization-agent",
    apiUrl: "http://localhost:2024",
  });

  const { scrollRef, contentRef } = useStickToBottom();
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [showSummarizationBanner, setShowSummarizationBanner] = useState(false);

  // Check for summary messages
  const hasSummary = stream.messages.some((m) => isSummaryMessage(m));

  // Show banner when summary first appears
  useEffect(() => {
    if (hasSummary && !showSummarizationBanner) {
      setShowSummarizationBanner(true);
      // Hide banner after 5 seconds
      const timer = setTimeout(() => setShowSummarizationBanner(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [hasSummary, showSummarizationBanner]);

  const hasMessages = stream.messages.length > 0;

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  const handlePrefill = useCallback(async () => {
    setIsPrefilling(true);
    try {
      // Get pre-filled messages (already in the correct format)
      const prefilledMessages = getPrefilledMessages();

      // Submit all pre-filled messages followed by a new message to trigger processing
      stream.submit({
        messages: [
          ...prefilledMessages,
          {
            content:
              "Thanks for all that information! Now I'd like to know more about the visa requirements for US citizens visiting Japan.",
            type: "human",
          },
        ],
      });
    } finally {
      setIsPrefilling(false);
    }
  }, [stream]);

  return (
    <div className="h-full flex flex-col">
      {/* Toast notification for summarization */}
      {showSummarizationBanner && (
        <SummarizationToast onClose={() => setShowSummarizationBanner(false)} />
      )}

      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {/* Stats panel */}
          {hasMessages && (
            <ConversationStats
              messageCount={
                stream.messages.filter((m) => m.type !== "tool").length
              }
              hasSummary={hasSummary}
            />
          )}

          {!hasMessages ? (
            <EmptyState
              onPrefill={handlePrefill}
              onSuggestionClick={handleSubmit}
              isPrefilling={isPrefilling}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => {
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
                  if (getContent(message).trim().length === 0) {
                    return null;
                  }
                }

                return (
                  <MessageBubble key={message.id ?? idx} message={message} />
                );
              })}

              {/* Loading indicator */}
              {stream.isLoading && <LoadingIndicator />}
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
                  : "An error occurred"}
              </span>
            </div>
          </div>
        </div>
      )}

      <MessageInput
        disabled={stream.isLoading || isPrefilling}
        placeholder="Ask me anything about travel planning..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

/**
 * Register this example
 */
registerExample({
  id: "summarization-agent",
  title: "Summarization Middleware",
  description:
    "Agent with automatic context summarization when conversation gets long",
  category: "middleware",
  icon: "middleware",
  ready: true,
  component: SummarizationAgent,
});

export default SummarizationAgent;
