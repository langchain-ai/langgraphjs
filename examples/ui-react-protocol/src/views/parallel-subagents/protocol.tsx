import {
  useCallback,
  useMemo,
  useState,
  type MouseEvent,
} from "react";

import type { BaseMessage } from "@langchain/core/messages";
import { useStream } from "@langchain/react";

import type { agent as parallelAgentType } from "../../agents/parallel-subagents";
import { Composer } from "../../components/Composer";
import { EventLog } from "../../components/EventLog";
import { JsonPanel } from "../../components/JsonPanel";
import { MessageFeed } from "../../components/MessageFeed";
import type { TraceEntry } from "../../components/ProtocolPlayground";
import type { PlaygroundTransportMode } from "../../components/ProtocolSwitcher";
import {
  ensureBaseMessages,
  formatNamespace,
  getLastAssistantMetadata,
  getSubagentPreview,
} from "../../utils";
import {
  API_URL,
  getStreamProtocol,
  getTransportLabel,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "../shared";
import {
  createTraceEntry,
  getLegacySubagentTitle,
  isNamespacePrefix,
  SESSION_ASSISTANT_ID,
  SUGGESTIONS,
} from "./common";

function formatSubagentNames(
  subagents: Array<{ title: string }>,
  maxVisible = 3
): string {
  if (subagents.length === 0) return "None";

  const names = subagents.map((subagent) => subagent.title);
  const visibleNames = names.slice(0, maxVisible);
  const remaining = names.length - visibleNames.length;

  return remaining > 0
    ? `${visibleNames.join(", ")} +${remaining} more`
    : visibleNames.join(", ");
}

export function ProtocolParallelSubagentsView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [modalToolCallId, setModalToolCallId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const [toolEvents, setToolEvents] = useState<
    Array<TraceEntry & { namespace?: string[] }>
  >([]);

  const stream = useStream<Awaited<ReturnType<typeof parallelAgentType>>>({
    assistantId: SESSION_ASSISTANT_ID,
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: getStreamProtocol(transportMode),
    throttle: true,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      const entry = {
        ...createTraceEntry("tool", summary.label, summary.detail, {
          data,
          namespace: options.namespace,
        }),
        namespace: options.namespace,
      };
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
      setToolEvents((current) => [entry, ...current].slice(0, 300));
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const handleSubmit = useCallback(
    (content: string) => {
      setModalToolCallId(null);
      setToolEvents([]);
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input, { streamSubgraphs: true });
    },
    [stream]
  );

  const subagents = useMemo(() => {
    const entries = Array.from(
      stream.subagents.entries() as Iterable<[string, unknown]>
    );

    return entries.map(([toolCallId, subagent], index) => {
      const state = subagent as {
        status?: string;
        messages?: BaseMessage[];
        namespace?: string[];
        values?: Record<string, unknown>;
        toolCall?: {
          args?: Record<string, unknown>;
        };
      };
      const snapshotMessages = ensureBaseMessages(state.values?.messages);
      const liveMessages = state.messages ?? [];
      const messages = liveMessages.length > 0 ? liveMessages : snapshotMessages;

      return {
        toolCallId,
        title: getLegacySubagentTitle(toolCallId, state.toolCall),
        status: state.status ?? "unknown",
        namespace: state.namespace ?? [],
        messages,
        messageCount: messages.length,
        preview: getSubagentPreview(messages),
        order: index + 1,
      };
    });
  }, [stream.subagents]);

  const selectedSubagent =
    modalToolCallId != null
      ? subagents.find((subagent) => subagent.toolCallId === modalToolCallId) ?? null
      : null;

  const subagentSummary = useMemo(() => {
    const running = subagents.filter(
      (subagent) => subagent.status.toLowerCase() === "running"
    );
    const completed = subagents.filter((subagent) => {
      const normalizedStatus = subagent.status.toLowerCase();
      return normalizedStatus === "complete" || normalizedStatus === "completed";
    });
    const others = subagents.filter((subagent) => {
      const normalizedStatus = subagent.status.toLowerCase();
      return (
        normalizedStatus !== "running" &&
        normalizedStatus !== "complete" &&
        normalizedStatus !== "completed"
      );
    });

    return {
      badge:
        subagents.length === 0
          ? "0 tracked"
          : [
              `${running.length} running`,
              `${completed.length} completed`,
              others.length > 0 ? `${others.length} other` : null,
            ]
              .filter(Boolean)
              .join(" / "),
      running,
      completed,
      others,
      runningLabel: formatSubagentNames(running),
      completedLabel: formatSubagentNames(completed),
      otherLabel: formatSubagentNames(others),
    };
  }, [subagents]);

  const selectedToolEvents = useMemo(() => {
    if (selectedSubagent == null) return [];
    return toolEvents.filter((entry) =>
      isNamespacePrefix(selectedSubagent.namespace, entry.namespace)
    );
  }, [selectedSubagent, toolEvents]);

  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  const modalTitleId = "parallel-subagent-protocol-activity-title";

  return (
    <>
      <section className="playground-shell">
        <header className="hero-card">
          <div>
            <div className="eyebrow">Protocol benchmark</div>
            <h2>Parallel Subagent Fan-Out</h2>
            <p>
              This version uses the built-in `useStream` protocol support, so the
              example can stream the QuickJS fan-out through the SDK&apos;s native
              session runtime without any custom protocol transport glue.
            </p>
          </div>
          <dl className="hero-metadata">
            <div>
              <dt>Assistant</dt>
              <dd>{SESSION_ASSISTANT_ID}</dd>
            </div>
            <div>
              <dt>API</dt>
              <dd>{API_URL}</dd>
            </div>
            <div>
              <dt>Protocol</dt>
              <dd>{getTransportLabel(transportMode)}</dd>
            </div>
            <div>
              <dt>Thread</dt>
              <dd>{threadId ?? "pending"}</dd>
            </div>
          </dl>
        </header>

        {stream.error != null ? (
          <div className="error-banner">
            {stream.error instanceof Error
              ? stream.error.message
              : "The protocol stream failed."}
          </div>
        ) : null}

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
              <h3>Protocol Root Stream</h3>
              <span className="conversation-status">
                {stream.isLoading ? "Streaming orchestrator..." : "Idle"}
              </span>
            </div>

            <MessageFeed
              getMessageMetadata={(message) =>
                stream.getMessagesMetadata?.(message as never)
              }
              messages={stream.messages}
            />

            <Composer
              disabled={stream.isLoading}
              onSubmit={handleSubmit}
              placeholder="Ask for poems for 8, 16, or all 100 customers and inspect the protocol-backed subagent streams."
            />
          </section>

          <aside className="sidebar-stack">
            <section className="panel-card">
              <div className="panel-card-header">
                <h3>Tracked Subagents</h3>
                <span className="conversation-status">{subagentSummary.badge}</span>
              </div>

              {subagents.length === 0 ? (
                <div className="empty-panel">
                  Start a protocol run to inspect how the built-in SDK subagent
                  tracking follows the customer-poet workers.
                </div>
              ) : (
                <>
                  <div className="subagent-meta">
                    Running: {subagentSummary.runningLabel}
                  </div>
                  <div className="subagent-meta">
                    Completed: {subagentSummary.completedLabel}
                  </div>
                  {subagentSummary.others.length > 0 ? (
                    <div className="subagent-meta">
                      Other: {subagentSummary.otherLabel}
                    </div>
                  ) : null}

                  <div className="parallel-subagent-list">
                    {subagents.map((subagent) => (
                      <button
                        key={subagent.toolCallId}
                        className="parallel-subagent-button"
                        onClick={() => setModalToolCallId(subagent.toolCallId)}
                        type="button"
                      >
                        <div className="subagent-header">
                          <strong>{subagent.title}</strong>
                          <span
                            className={`status-pill status-${subagent.status.toLowerCase()}`}
                          >
                            {subagent.status}
                          </span>
                        </div>
                        <div className="subagent-meta">
                          Namespace: {formatNamespace(subagent.namespace)}
                        </div>
                        <div className="subagent-meta">
                          {subagent.messageCount} streamed message
                          {subagent.messageCount === 1 ? "" : "s"}
                        </div>
                        {subagent.preview ? (
                          <div className="subagent-preview">{subagent.preview}</div>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>

            <JsonPanel
              title="Protocol Snapshot"
              value={{
                assistantId: SESSION_ASSISTANT_ID,
                protocol: getTransportLabel(transportMode),
                threadId,
                loading: stream.isLoading,
                mainMessageCount: stream.messages.length,
                subagentCount: subagents.length,
                selectedSubagent: selectedSubagent?.toolCallId ?? null,
              }}
            />
            <JsonPanel title="Last Assistant Metadata" value={metadata} />
            <EventLog eventLog={eventLog} />
          </aside>
        </div>
      </section>

      {selectedSubagent != null ? (
        <div
          className="parallel-modal-backdrop"
          onClick={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            setModalToolCallId(null);
          }}
          role="presentation"
        >
          <section
            aria-labelledby={modalTitleId}
            aria-modal="true"
            className="parallel-modal"
            role="dialog"
          >
            <div className="panel-card-header">
              <div>
                <h3 id={modalTitleId}>{selectedSubagent.title}</h3>
                <div className="subagent-meta">
                  Namespace: {formatNamespace(selectedSubagent.namespace)}
                </div>
              </div>
              <div className="parallel-modal-actions">
                <span
                  className={`status-pill status-${selectedSubagent.status.toLowerCase()}`}
                >
                  {selectedSubagent.status}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => setModalToolCallId(null)}
                  type="button"
                >
                  Close popup
                </button>
              </div>
            </div>

            <div className="parallel-modal-grid">
              <section className="panel-card">
                <div className="panel-card-header">
                  <h3>Messages</h3>
                  <span className="conversation-status">
                    {selectedSubagent.messages.length} total
                  </span>
                </div>
                <MessageFeed messages={selectedSubagent.messages} />
              </section>

              <EventLog eventLog={selectedToolEvents} />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
