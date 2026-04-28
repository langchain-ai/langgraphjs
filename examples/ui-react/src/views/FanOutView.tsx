import { useCallback, useMemo, useState, type MouseEvent } from "react";

import {
  useMessages,
  useStream,
  useToolCalls,
  type SubagentDiscoverySnapshot,
  type UseStreamReturn,
} from "@langchain/react";

import type { agent as fanOutAgentType } from "../agents/fan-out";
import { API_URL, type Transport } from "../api";
import { Composer } from "../components/Composer";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import { RecentEvents } from "../components/RecentEvents";
import { ViewShell } from "../components/ViewShell";
import { formatNamespace } from "../utils";
import { useEventTrace } from "./shared";

const ASSISTANT_ID = "fan-out";

const SUGGESTIONS = [
  "Run the full 100-worker fan-out about the future of developer tools.",
  "Fan out 150 workers about the history of distributed systems.",
  "Run 24 workers covering different angles of real-time streaming.",
];

type FanOutStream = ReturnType<
  typeof useStream<Awaited<ReturnType<typeof fanOutAgentType>>>
>;
type StreamState = FanOutStream["values"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type GenericStream = UseStreamReturn<any, any, any>;

type StatusFilter = "all" | "running" | "complete" | "error";

export function FanOutView({ transport }: { transport: Transport }) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [modalSubagentId, setModalSubagentId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const stream = useStream<
    Awaited<ReturnType<typeof fanOutAgentType>>
  >({
    assistantId: ASSISTANT_ID,
    apiUrl: API_URL,
    transport,
    threadId,
    onThreadId: setThreadId,
  });

  const eventTrace = useEventTrace(stream);

  const handleSubmit = useCallback(
    (content: string) => {
      setModalSubagentId(null);
      const input = {
        messages: [{ content, type: "human" }],
      } as unknown as Partial<StreamState>;
      void stream.submit(input);
    },
    [stream]
  );

  const subagents = useMemo(
    () => Array.from(stream.subagents.values()),
    [stream.subagents]
  );

  const summary = useMemo(() => {
    const running = subagents.filter((s) => s.status === "running").length;
    const complete = subagents.filter((s) => s.status === "complete").length;
    const errored = subagents.filter((s) => s.status === "error").length;
    return { running, complete, errored };
  }, [subagents]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return subagents;
    return subagents.filter((s) => s.status === statusFilter);
  }, [subagents, statusFilter]);

  const selectedSubagent =
    modalSubagentId != null
      ? ((
          stream.subagents as ReadonlyMap<
            string,
            ReturnType<typeof stream.subagents.get>
          >
        ).get(modalSubagentId) ?? null)
      : null;

  const modalTitleId = "fanout-subagent-modal-title";

  return (
    <>
      <ViewShell
        assistantId={ASSISTANT_ID}
        threadId={threadId}
        transport={transport}
        title="Fan-Out (100+ workers)"
        description={
          <>
            A Deep Agent with QuickJS spawns N worker subagents in parallel.
            Only discovery metadata is eagerly streamed — opening a worker's
            popup mounts a ref-counted <code>useMessages</code> +{" "}
            <code>useToolCalls</code> pair, and closing the popup tears the
            subscription down again.
          </>
        }
        error={stream.error}
      >
        <div className="suggestion-row">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className="suggestion-chip"
              disabled={stream.isLoading}
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
                {stream.isLoading ? "Spawning workers..." : "Idle"}
              </span>
            </div>
            <MessageFeed isStreaming={stream.isLoading} messages={stream.messages} />
            <Composer
              disabled={stream.isLoading}
              onSubmit={handleSubmit}
              placeholder="Ask for a fan-out over a topic; click any worker row to inspect its scoped stream."
            />
          </section>

          <aside className="sidebar-stack">
            <section className="panel-card">
              <div className="panel-card-header">
                <h3>Workers</h3>
                <span className="conversation-status">
                  {subagents.length} tracked · {summary.running} running /{" "}
                  {summary.complete} done
                  {summary.errored > 0 ? ` / ${summary.errored} err` : ""}
                </span>
              </div>

              <div className="fanout-filter-row">
                {(
                  ["all", "running", "complete", "error"] as StatusFilter[]
                ).map((filter) => (
                  <button
                    key={filter}
                    className={`fanout-filter-chip ${
                      statusFilter === filter
                        ? "fanout-filter-chip-active"
                        : ""
                    }`}
                    onClick={() => setStatusFilter(filter)}
                    type="button"
                  >
                    {filter}
                  </button>
                ))}
              </div>

              {filtered.length === 0 ? (
                <div className="empty-panel">
                  {subagents.length === 0
                    ? "Kick off a run to watch the coordinator fan out workers."
                    : "No workers match this filter."}
                </div>
              ) : (
                <div className="fanout-grid">
                  {filtered.map((subagent) => (
                    <FanOutRow
                      key={subagent.id}
                      onSelect={() => setModalSubagentId(subagent.id)}
                      subagent={subagent}
                    />
                  ))}
                </div>
              )}
            </section>

            <JsonPanel
              title="Run Snapshot"
              value={{
                assistantId: ASSISTANT_ID,
                transport,
                threadId,
                loading: stream.isLoading,
                rootMessages: stream.messages.length,
                subagentCount: subagents.length,
                openSubagent: modalSubagentId,
              }}
            />
            <RecentEvents events={eventTrace} />
          </aside>
        </div>
      </ViewShell>

      {selectedSubagent != null ? (
        <FanOutSubagentModal
          labelId={modalTitleId}
          onClose={() => setModalSubagentId(null)}
          stream={stream as unknown as GenericStream}
          subagent={selectedSubagent}
        />
      ) : null}
    </>
  );
}

function FanOutRow({
  onSelect,
  subagent,
}: {
  onSelect: () => void;
  subagent: SubagentDiscoverySnapshot;
}) {
  const label = deriveWorkerLabel(subagent);

  return (
    <button
      className={`fanout-row fanout-row-${subagent.status}`}
      onClick={onSelect}
      type="button"
    >
      <div className="fanout-row-header">
        <strong>{label}</strong>
        <span className={`status-pill status-${subagent.status}`}>
          {subagent.status}
        </span>
      </div>
      {subagent.taskInput != null ? (
        <div className="fanout-row-preview">{subagent.taskInput}</div>
      ) : null}
    </button>
  );
}

function deriveWorkerLabel(subagent: SubagentDiscoverySnapshot): string {
  if (typeof subagent.taskInput === "string") {
    const match = subagent.taskInput.match(/worker-\d+/i);
    if (match != null) return match[0];
  }
  return subagent.name;
}

function FanOutSubagentModal({
  labelId,
  onClose,
  stream,
  subagent,
}: {
  labelId: string;
  onClose: () => void;
  stream: GenericStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  const label = deriveWorkerLabel(subagent);

  return (
    <div
      className="parallel-modal-backdrop"
      onClick={(event: MouseEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        onClose();
      }}
      role="presentation"
    >
      <section
        aria-labelledby={labelId}
        aria-modal="true"
        className="parallel-modal"
        role="dialog"
      >
        <div className="panel-card-header">
          <div>
            <h3 id={labelId}>{label}</h3>
            <div className="subagent-meta">
              Namespace: {formatNamespace([...subagent.namespace])}
            </div>
          </div>
          <div className="parallel-modal-actions">
            <span className={`status-pill status-${subagent.status}`}>
              {subagent.status}
            </span>
            <button
              className="secondary-button"
              onClick={onClose}
              type="button"
            >
              Close popup
            </button>
          </div>
        </div>

        <FanOutSubagentContent stream={stream} subagent={subagent} />
      </section>
    </div>
  );
}

function FanOutSubagentContent({
  stream,
  subagent,
}: {
  stream: GenericStream;
  subagent: SubagentDiscoverySnapshot;
}) {
  // Mount = open a ref-counted messages + tools subscription for this
  // subagent's namespace. Close the modal and they unsubscribe. This is
  // the whole point of the fan-out demo.
  const messages = useMessages(stream, subagent);
  const toolCalls = useToolCalls(stream, subagent);

  return (
    <div className="parallel-modal-grid">
      <section className="panel-card">
        <div className="panel-card-header">
          <h3>Messages</h3>
          <span className="conversation-status">
            {messages.length} total · {toolCalls.length} tool call
            {toolCalls.length === 1 ? "" : "s"}
          </span>
        </div>
        {messages.length === 0 ? (
          <div className="empty-panel">
            Waiting for streamed output from this worker...
          </div>
        ) : (
          <MessageFeed
            isStreaming={subagent.status === "running"}
            messages={messages}
          />
        )}
      </section>

      <JsonPanel
        title="Tool Calls"
        value={toolCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          namespace: call.namespace,
          input: call.input,
        }))}
      />
    </div>
  );
}
