import { useCallback, useMemo, useState } from "react";
import {
  useChannel,
  useMessages,
  useStream,
  useToolCalls,
  type Event,
} from "@langchain/react";

import type { agent as toolStreamingAgentType } from "../agents/tool-streaming";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { isRecord } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "tool-streaming";

const SUGGESTIONS = [
  "Plan a five-day food and culture trip to Tokyo next April.",
  "Search flights to Lisbon for 2026-05-12 and check hotels for four nights.",
  "Build a three-day itinerary for Copenhagen focused on design and food.",
];

interface ProgressPayload {
  message: string;
  progress: number;
  completed?: string[];
}

export function ToolStreamingView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const stream = useStream<typeof toolStreamingAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const messages = useMessages(stream);
  const toolCalls = useToolCalls(stream);
  const toolEvents = useChannel(stream, ["tools"], undefined, {
    bufferSize: 80,
  });
  const eventTrace = useEventTrace(stream);
  const progressItems = useMemo(
    () => toolEvents.flatMap(extractProgressPayload),
    [toolEvents]
  );

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({ messages: [{ content, type: "human" }] });
    },
    [stream]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Tool Streaming"
      description={
        <>
          Async-generator tools emit progress payloads as they work. This view
          subscribes to the raw <code>tools</code> channel and renders live
          progress next to the normal message and tool-call stream.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
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

      <div className="playground-grid">
        <section className="conversation-card">
          <div className="panel-card-header">
            <h3>Travel planner</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Ask for travel planning that requires multiple tools."
          />
        </section>

        <aside className="sidebar-stack">
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Tool Progress</h3>
              <span>{progressItems.length} updates</span>
            </div>
            <div className="tool-progress-list">
              {progressItems.length === 0 ? (
                <div className="empty-panel">
                  Progress updates appear while generator tools are running.
                </div>
              ) : (
                progressItems.map((item, index) => (
                  <ToolProgressCard item={item} key={`${item.message}-${index}`} />
                ))
              )}
            </div>
          </section>
          <JsonPanel title="Tool Calls" value={toolCalls} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}

function ToolProgressCard({ item }: { item: ProgressPayload }) {
  const percent = Math.round(item.progress * 100);
  return (
    <div className="tool-progress-card">
      <div className="tool-progress-header">
        <span>{item.message}</span>
        <strong>{percent}%</strong>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${percent}%` }} />
      </div>
      {item.completed?.length ? (
        <ul>
          {item.completed.map((entry) => (
            <li key={entry}>{entry}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function extractProgressPayload(event: Event): ProgressPayload[] {
  const candidates = collectRecords(event);
  return candidates
    .filter(
      (candidate): candidate is Record<string, unknown> & ProgressPayload =>
        typeof candidate.message === "string" &&
        typeof candidate.progress === "number"
    )
    .map((candidate) => ({
      message: candidate.message,
      progress: Math.max(0, Math.min(1, candidate.progress)),
      completed: Array.isArray(candidate.completed)
        ? candidate.completed.filter(
            (value): value is string => typeof value === "string"
          )
        : undefined,
    }));
}

function collectRecords(value: unknown): Record<string, unknown>[] {
  if (!isRecord(value)) return [];
  const records = [value];
  for (const child of Object.values(value)) {
    if (isRecord(child)) records.push(...collectRecords(child));
    if (Array.isArray(child)) {
      for (const item of child) records.push(...collectRecords(item));
    }
  }
  return records;
}
