import { useCallback, useState } from "react";
import { useStickToBottom } from "use-stick-to-bottom";
import { AlertCircle, Radio } from "lucide-react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";

import { registerExample } from "../registry";
import { LoadingIndicator } from "../../components/Loading";
import { EmptyState } from "../../components/States";
import { MessageBubble } from "../../components/MessageBubble";
import { MessageInput } from "../../components/MessageInput";

import type { agent } from "./agent";
import {
  isProgressData,
  isStatusData,
  isFileStatusData,
  type ProgressData,
  type StatusData,
  type FileStatusData,
} from "./types";
import { ProgressCard } from "./components/ProgressCard";
import { StatusBadge } from "./components/StatusBadge";
import { FileOperationCard } from "./components/FileOperationCard";

const CUSTOM_STREAMING_SUGGESTIONS = [
  "Analyze sales data for trends",
  "Process and compress report.pdf",
  "Analyze inventory for anomalies",
  "Validate config.json and transform data.csv",
];

/**
 * Helper to check if a message has actual text content.
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

export function CustomStreaming() {
  /**
   * State to store custom streaming events received via onCustomEvent
   */
  const [customEvents, setCustomEvents] = useState<{
    progressData: Map<string, ProgressData>;
    statusData: Map<string, StatusData>;
    fileStatusData: Map<string, FileStatusData>;
  }>({
    progressData: new Map(),
    statusData: new Map(),
    fileStatusData: new Map(),
  });

  /**
   * Handle custom events from the stream
   * The callback receives (data: unknown, options) - we type-check data inside
   */
  const handleCustomEvent = useCallback((data: unknown) => {
    setCustomEvents((prev) => {
      if (isProgressData(data)) {
        const newProgressData = new Map(prev.progressData);
        newProgressData.set(data.id, data);
        return { ...prev, progressData: newProgressData };
      } else if (isStatusData(data)) {
        const newStatusData = new Map(prev.statusData);
        newStatusData.set(data.id, data);
        return { ...prev, statusData: newStatusData };
      } else if (isFileStatusData(data)) {
        const newFileStatusData = new Map(prev.fileStatusData);
        newFileStatusData.set(data.id, data);
        return { ...prev, fileStatusData: newFileStatusData };
      }
      return prev;
    });
  }, []);

  const stream = useStream<typeof agent>({
    assistantId: "custom-streaming",
    apiUrl: "http://localhost:2024",
    onCustomEvent: handleCustomEvent,
  });

  const { scrollRef, contentRef } = useStickToBottom();

  /**
   * Reset custom events when starting a new conversation
   */
  const handleSubmit = useCallback(
    (content: string) => {
      // Clear previous custom events when sending a new message
      setCustomEvents({
        progressData: new Map(),
        statusData: new Map(),
        fileStatusData: new Map(),
      });
      stream.submit({ messages: [{ content, type: "human" } as any] });
    },
    [stream]
  );

  const hasMessages = stream.messages.length > 0;

  /**
   * Convert maps to arrays for rendering
   */
  const progressDataArray = Array.from(customEvents.progressData.values());
  const statusDataArray = Array.from(customEvents.statusData.values());
  const fileStatusDataArray = Array.from(customEvents.fileStatusData.values());

  /**
   * Check if we have any custom streaming data
   */
  const hasCustomData =
    progressDataArray.length > 0 ||
    statusDataArray.length > 0 ||
    fileStatusDataArray.length > 0;

  /**
   * Check if all progress is complete (100%)
   */
  const isProgressComplete =
    progressDataArray.length > 0 &&
    progressDataArray.every((p) => p.progress === 100);

  /**
   * Get custom events associated with a specific tool call ID
   */
  const getEventsForToolCall = useCallback(
    (toolCallId: string) => {
      const status = statusDataArray.filter(
        (d) => d.toolCall?.id === toolCallId
      );
      const progress = progressDataArray.filter(
        (d) =>
          d.toolCall?.id === toolCallId &&
          /**
           * don't show progress if status is complete
           */
          (status.length === 0 || status.some((s) => s.status !== "complete"))
      );
      const fileStatus = fileStatusDataArray.filter(
        (d) => d.toolCall?.id === toolCallId
      );
      return { progress, status, fileStatus };
    },
    [progressDataArray, statusDataArray, fileStatusDataArray]
  );

  return (
    <div className="h-full flex flex-col">
      <main ref={scrollRef} className="flex-1 overflow-y-auto">
        <div ref={contentRef} className="max-w-2xl mx-auto px-4 py-8">
          {!hasMessages ? (
            <EmptyState
              icon={Radio}
              title="Custom Streaming Events"
              description="Demonstrate streaming custom data from LangGraph nodes to the UI. Watch progress bars, status updates, and file operations stream in real-time as tools execute."
              suggestions={CUSTOM_STREAMING_SUGGESTIONS}
              onSuggestionClick={handleSubmit}
            />
          ) : (
            <div className="flex flex-col gap-6">
              {stream.messages.map((message, idx) => {
                const customCards =
                  message.type === "ai"
                    ? message.tool_calls?.map((toolCall) => {
                        const { progress, status, fileStatus } =
                          getEventsForToolCall(toolCall.id!);
                        return (
                          <div key={toolCall.id}>
                            {progress.map((data) => (
                              <ProgressCard key={data.id} data={data} />
                            ))}
                            {status.map((data) => (
                              <StatusBadge key={data.id} data={data} />
                            ))}
                            {fileStatus.map((data) => (
                              <FileOperationCard key={data.id} data={data} />
                            ))}
                          </div>
                        );
                      }) ?? []
                    : [];

                return [
                  <MessageBubble key={message.id ?? idx} message={message} />,
                  ...customCards,
                ];
              })}

              {/* Show loading indicator when streaming and no content yet */}
              {stream.isLoading &&
                !stream.messages.some(
                  (m) => m.type === "ai" && hasContent(m)
                ) &&
                !hasCustomData && <LoadingIndicator />}

              {/* Show streaming indicator when we have active progress */}
              {stream.isLoading && hasCustomData && !isProgressComplete && (
                <div className="flex items-center gap-3 text-indigo-400/70">
                  <div className="flex items-center gap-1">
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-ping" />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-ping [animation-delay:150ms]" />
                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-ping [animation-delay:300ms]" />
                  </div>
                  <span className="text-sm">Streaming custom events...</span>
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
        placeholder="Ask me to analyze data or process files..."
        onSubmit={handleSubmit}
      />
    </div>
  );
}

// Register this example
registerExample({
  id: "custom-streaming",
  title: "Custom Streaming Events",
  description:
    "Stream custom data like progress bars and status updates from LangGraph tools",
  category: "advanced",
  icon: "code",
  ready: true,
  component: CustomStreaming,
});

export default CustomStreaming;
