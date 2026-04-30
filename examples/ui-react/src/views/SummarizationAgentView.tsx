import { useCallback, useMemo, useState } from "react";
import { type InferStateType, useMessages, useStream } from "@langchain/react";

import type { agent as summarizationAgentType } from "../agents/summarization-agent";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { getPrefilledMessages } from "../prefilledMessages";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "summarization-agent";

const SUGGESTIONS = [
  "What should we book first?",
  "Calculate the total food budget at $70 per day for 14 days.",
  "Save the most important itinerary note.",
];

const isSummaryText = (content: string) =>
  content.toLowerCase().includes("conversation summary");

export function SummarizationAgentView({
  transport,
}: {
  transport: Transport;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const stream = useStream<typeof summarizationAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const messages = useMessages(stream);
  const eventTrace = useEventTrace(stream);
  const hasSummary = useMemo(
    () => messages.some((message) => isSummaryText(message.text)),
    [messages]
  );

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  const triggerSummarization = useCallback(() => {
    const input = {
      messages: getPrefilledMessages(),
    } as Partial<InferStateType<typeof summarizationAgentType>>;
    void stream.submit(input);
  }, [stream]);

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Summarization Middleware"
      description={
        <>
          Submit a seeded long conversation to trigger the summarization
          middleware. The view highlights when a summary enters the message
          history and keeps the rest of the conversation stream visible.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        <button
          className="suggestion-chip"
          disabled={stream.isLoading}
          onClick={triggerSummarization}
          type="button"
        >
          Load long conversation
        </button>
        {SUGGESTIONS.map((suggestion) => (
          <button
            className="suggestion-chip"
            key={suggestion}
            onClick={() => handleSubmit(suggestion)}
            type="button"
          >
            {suggestion}
          </button>
        ))}
      </div>

      {hasSummary ? (
        <div className="summary-banner">
          Summarization has run. Older context was compacted into a summary
          message while recent turns stayed available.
        </div>
      ) : null}

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Conversation</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Continue the travel planning conversation."
          />
        </section>

        <aside className="sidebar-stack">
          <JsonPanel
            title="Summary Status"
            value={{
              hasSummary,
              messageCount: messages.length,
            }}
          />
          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}
