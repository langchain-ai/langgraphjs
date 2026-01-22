import { useState, useCallback, useEffect } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import {
  AlertCircle,
  RotateCcw,
  Wifi,
  Hash,
  RefreshCw,
  Zap,
  CheckCircle2,
  Radio,
} from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageInput } from "../../components/MessageInput";
import { MessageBubble } from "../../components/MessageBubble";

import type { agent } from "./agent";

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
 * Connection status indicator
 */
function ConnectionStatus({
  isLoading,
  isReconnecting,
  threadId,
}: {
  isLoading: boolean;
  isReconnecting: boolean;
  threadId: string | null;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-2 rounded-lg bg-neutral-800/80 border border-neutral-700">
      {/* Connection indicator */}
      <div className="flex items-center gap-2">
        {isReconnecting ? (
          <>
            <Radio className="w-4 h-4 text-amber-400 animate-pulse" />
            <span className="text-xs text-amber-400">Reconnecting...</span>
          </>
        ) : isLoading ? (
          <>
            <Radio className="w-4 h-4 text-green-400 animate-pulse" />
            <span className="text-xs text-green-400">Streaming</span>
          </>
        ) : (
          <>
            <Wifi className="w-4 h-4 text-neutral-500" />
            <span className="text-xs text-neutral-400">Ready</span>
          </>
        )}
      </div>

      {/* Thread ID */}
      {threadId && (
        <>
          <div className="w-px h-4 bg-neutral-700" />
          <div className="flex items-center gap-1.5">
            <Hash className="w-3 h-3 text-neutral-500" />
            <code className="text-xs text-neutral-500 font-mono">
              {threadId.slice(0, 8)}...
            </code>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Reconnection banner shown when stream is resumed
 */
function ReconnectedBanner({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-green-950/40 border border-green-500/30 animate-fade-in">
      <CheckCircle2 className="w-5 h-5 text-green-400" />
      <div className="flex-1">
        <div className="text-sm font-medium text-green-300">
          Stream Reconnected
        </div>
        <div className="text-xs text-green-400/70">
          Successfully resumed the in-flight stream after page refresh
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  "Write me a long story about a robot learning to paint",
  "Explain quantum computing in detail with examples",
  "Create a comprehensive guide to learning TypeScript",
];

export function SessionPersistence() {
  const [threadId, setThreadId] = useThreadIdParam();
  const [showReconnectedBanner, setShowReconnectedBanner] = useState(false);
  const [hasReconnected, setHasReconnected] = useState(false);

  /**
   * useStream with reconnectOnMount enabled.
   *
   * This automatically resumes an ongoing stream after page refresh.
   * The run ID is stored in sessionStorage and used to rejoin the stream.
   *
   * See: https://docs.langchain.com/langsmith/use-stream-react#resume-a-stream-after-page-refresh
   */
  const stream = useStream<typeof agent>({
    assistantId: "session-persistence",
    apiUrl: "http://localhost:2024",
    threadId: threadId ?? undefined,
    onThreadId: setThreadId,
    // Enable automatic stream reconnection after page refresh
    reconnectOnMount: true,
    // Called when the stream finishes
    onFinish: () => {
      // Check if we reconnected to a stream
      if (hasReconnected) {
        setShowReconnectedBanner(true);
        setHasReconnected(false);
      }
    },
  });

  // Detect if we're reconnecting to an existing stream
  useEffect(() => {
    if (stream.isLoading && threadId) {
      // Check if there's a stored run ID for this thread (indicates reconnection)
      const storedRunId = window.sessionStorage.getItem(
        `lg:stream:${threadId}`
      );
      if (storedRunId) {
        setHasReconnected(true);
      }
    }
  }, [stream.isLoading, threadId]);

  const { scrollRef, contentRef } = useStickToBottom();

  const handleSubmit = useCallback(
    (content: string) => {
      stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  /**
   * Simulate a page refresh to demonstrate reconnection
   */
  const handleSimulateRefresh = useCallback(() => {
    window.location.reload();
  }, []);

  const hasMessages = stream.messages.length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header with connection status */}
      <div className="border-b border-neutral-800 px-8 py-2 flex items-center justify-between">
        <ConnectionStatus
          isLoading={stream.isLoading}
          isReconnecting={hasReconnected && stream.isLoading}
          threadId={threadId}
        />

        {/* Refresh button - only show during streaming */}
        {stream.isLoading && (
          <button
            onClick={handleSimulateRefresh}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-xs hover:bg-amber-500/20 transition-colors"
            title="Refresh page to test stream reconnection"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh to Test Reconnect
          </button>
        )}
      </div>

      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={RotateCcw}
              title="Stream Reconnection Demo"
              description="This example demonstrates reconnectOnMount - the ability to resume an in-flight stream after a page refresh. Start a long response, then click 'Refresh to Test Reconnect' while streaming."
              suggestions={SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {/* Reconnected banner */}
              {showReconnectedBanner && (
                <ReconnectedBanner
                  onDismiss={() => setShowReconnectedBanner(false)}
                />
              )}

              {/* How it works info box */}
              {hasMessages && stream.messages.length <= 2 && (
                <div className="flex items-start gap-3 px-4 py-3 rounded-xl bg-blue-950/30 border border-blue-500/20 animate-fade-in">
                  <Zap className="w-5 h-5 text-blue-400 mt-0.5" />
                  <div>
                    <div className="text-sm font-medium text-blue-300 mb-1">
                      Try refreshing during the response!
                    </div>
                    <div className="text-xs text-blue-400/70">
                      The{" "}
                      <code className="px-1 py-0.5 rounded bg-blue-900/50">
                        reconnectOnMount: true
                      </code>{" "}
                      option automatically resumes the stream. The run ID is
                      stored in sessionStorage.
                    </div>
                  </div>
                </div>
              )}

              {stream.messages.map((message, idx) => (
                <MessageBubble key={message.id ?? idx} message={message} />
              ))}

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
        disabled={stream.isLoading}
        placeholder="Ask for a long response, then refresh mid-stream..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "session-persistence",
  title: "Stream Reconnection",
  description:
    "Resume an in-flight stream after page refresh with reconnectOnMount",
  category: "langgraph",
  icon: "graph",
  ready: true,
  component: SessionPersistence,
});

export default SessionPersistence;
