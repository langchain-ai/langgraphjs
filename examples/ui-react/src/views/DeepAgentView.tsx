import { useCallback, useMemo, useState } from "react";

import {
  useMessages,
  useStream,
  useToolCalls,
  type SubagentDiscoverySnapshot,
  type UseStreamReturn,
} from "@langchain/react";

import type { agent as deepAgentType } from "../agents/deep-agent";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { formatNamespace } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "deep-agent";

const SUGGESTIONS = [
  "Write a haiku, limerick, quatrain, and fifty-line poem about spring rain in the city.",
  "Create a haiku, limerick, quatrain, and fifty-line poem about debugging late at night.",
];

type DeepStream = ReturnType<typeof useStream<typeof deepAgentType>>;
type StreamState = DeepStream["values"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericStream = UseStreamReturn<any, any, any>;

export function DeepAgentView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [expandedSubagentId, setExpandedSubagentId] = useState<string | null>(
    null
  );

  const stream = useStream<typeof deepAgentType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const eventTrace = useEventTrace(stream);

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as unknown as Partial<StreamState>;
      setExpandedSubagentId(null);
      void stream.submit(input);
    },
    [stream]
  );

  const subagents = useMemo(
    () => Array.from(stream.subagents.values()),
    [stream.subagents]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Deep Agent"
      description={
        <>
          A coordinator dispatches four poetry specialists. Discovery metadata
          rides the always-on root subscription; each subagent's scoped
          messages + tool calls are only fetched when you expand the card.
        </>
      }
      error={stream.error}
    >
      <div className="suggestion-row">
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion}
            className="suggestion-chip"
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
            <h3>Coordinator</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={stream.messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Pick a topic and ask for a haiku, limerick, quatrain, and fifty-line poem."
          />
        </section>

        <aside className="sidebar-stack">
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Subagents</h3>
              <span className="conversation-status">
                {subagents.length} discovered
              </span>
            </div>
            {subagents.length === 0 ? (
              <div className="empty-panel">
                Subagents appear here once the coordinator dispatches one.
                Expand a card to open its scoped message + tool streams.
              </div>
            ) : (
              <div className="subagent-list">
                {subagents.map((subagent) => (
                  <SubagentCard
                    expanded={expandedSubagentId === subagent.id}
                    key={subagent.id}
                    onToggle={() =>
                      setExpandedSubagentId((current) =>
                        current === subagent.id ? null : subagent.id
                      )
                    }
                    stream={stream as unknown as GenericStream}
                    subagent={subagent}
                  />
                ))}
              </div>
            )}
          </section>

          <JsonPanel title="Current State" value={stream.values} />
          <RecentEvents events={eventTrace} />
        </aside>
      </div>
    </ViewShell>
  );
}

function SubagentCard({
  expanded,
  onToggle,
  stream,
  subagent,
}: {
  expanded: boolean;
  onToggle: () => void;
  stream: GenericStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  return (
    <article className="subagent-card">
      <button
        className="subagent-card-toggle"
        onClick={onToggle}
        style={{
          all: "unset",
          cursor: "pointer",
          display: "block",
          width: "100%",
        }}
        type="button"
      >
        <div className="subagent-header">
          <strong>{subagent.name}</strong>
          <span className={`status-pill status-${subagent.status}`}>
            {subagent.status}
          </span>
        </div>
        <div className="subagent-meta">
          Namespace: {formatNamespace([...subagent.namespace])}
        </div>
        {subagent.taskInput != null ? (
          <div className="subagent-preview">{subagent.taskInput}</div>
        ) : null}
        <div className="subagent-meta">
          {expanded ? "Hide live stream" : "Show live stream"}
        </div>
      </button>

      {expanded ? (
        <SubagentLiveStream stream={stream} subagent={subagent} />
      ) : null}
    </article>
  );
}

function SubagentLiveStream({
  stream,
  subagent,
}: {
  stream: GenericStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);

  return (
    <div className="subagent-live-stream">
      <div className="subagent-meta">
        {messages.length} streamed message{messages.length === 1 ? "" : "s"} ·{" "}
        {toolCalls.length} tool call{toolCalls.length === 1 ? "" : "s"}
      </div>
      {messages.length === 0 ? (
        <div className="empty-panel">
          Waiting for the subagent to produce output...
        </div>
      ) : (
        <MessageFeed
          isStreaming={subagent.status === "running"}
          messages={messages}
        />
      )}
    </div>
  );
}
