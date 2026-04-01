import { useCallback, useMemo, useState } from "react";

import {
  useMessages,
  useStream,
  type AnyStream,
  type SubgraphDiscoverySnapshot,
} from "@langchain/react";
import { HumanMessage } from "langchain";

import type { agent as nestedStateGraphType } from "../agents/nested-stategraph";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { formatNamespace, getSubagentPreview } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "nested-stategraph";

const SUGGESTIONS = [
  "Give me a briefing on the risks of rolling out the new streaming SDK.",
  "Research the current state of ephemeral dev agents and rank the risks.",
];

export function NestedStateGraphView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);

  const stream = useStream<typeof nestedStateGraphType>({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const eventTrace = useEventTrace(stream);

  const handleSubmit = useCallback(
    (content: string) => {
      void stream.submit({
        messages: [new HumanMessage(content)],
      });
    },
    [stream]
  );

  const subgraphs = useMemo(
    () => Array.from(stream.subgraphs.values()),
    [stream.subgraphs]
  );

  return (
    <ViewShell
      assistantId={ASSISTANT_ID}
      threadId={threadId}
      transport={transport}
      title="Nested StateGraph"
      description={
        <>
          An orchestrator graph dispatches two compiled subgraphs — a research
          loop and a risk analyst — before handing off to a writer. Parent
          state only carries the root conversation plus distilled{" "}
          <code>researchBrief</code> / <code>riskReport</code> artifacts, so
          the main feed stays clean while each subgraph streams its full
          tool-calling chatter in its own namespace. The sidebar lazily mounts
          a per-subgraph <code>useMessages</code> subscription only when its
          card renders.
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
            <h3>Root Conversation</h3>
            <span className="conversation-status">
              {stream.isLoading ? "Streaming..." : "Idle"}
            </span>
          </div>
          <MessageFeed isStreaming={stream.isLoading} messages={stream.messages} />
          <Composer
            disabled={stream.isLoading}
            onSubmit={handleSubmit}
            placeholder="Ask for a research briefing to kick off the researcher + analyst subgraphs."
          />
        </section>

        <aside className="sidebar-stack">
          <section className="panel-card">
            <div className="panel-card-header">
              <h3>Discovered Subgraphs</h3>
              <span className="conversation-status">
                {subgraphs.length} tracked
              </span>
            </div>
            {subgraphs.length === 0 ? (
              <div className="empty-panel">
                Subgraphs show up as their lifecycle events land. Each card
                below opens its own <code>useMessages</code> subscription for
                the scoped namespace.
              </div>
            ) : (
              <div className="subagent-list">
                {subgraphs.map((subgraph) => (
                  <SubgraphCard
                    key={subgraph.id}
                    stream={stream}
                    subgraph={subgraph}
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

/**
 * Mount = open a `messages` subscription for the subgraph's namespace.
 * Unmount = ref-count drops to zero and the subscription closes. Two
 * cards viewing the same subgraph share a single server subscription.
 */
function SubgraphCard({
  stream,
  subgraph,
}: {
  stream: AnyStream;
  subgraph: SubgraphDiscoverySnapshot;
}) {
  const messages = useMessages(stream, subgraph);
  const preview = getSubagentPreview(messages);
  const nodeLabel = subgraph.namespace[0] ?? "subgraph";

  return (
    <article className="subagent-card">
      <div className="subagent-header">
        <strong>{nodeLabel}</strong>
        <span className={`status-pill status-${subgraph.status}`}>
          {subgraph.status}
        </span>
      </div>
      <div className="subagent-meta">
        Namespace: {formatNamespace([...subgraph.namespace])}
      </div>
      <div className="subagent-meta">
        {messages.length} streamed message{messages.length === 1 ? "" : "s"}
      </div>
      {preview ? <div className="subagent-preview">{preview}</div> : null}
    </article>
  );
}
