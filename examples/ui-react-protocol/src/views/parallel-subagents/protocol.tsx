import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import type { Message } from "@langchain/langgraph-sdk";
import {
  extractToolCallIdFromNamespace,
  MessageTupleManager,
} from "@langchain/langgraph-sdk/ui";
import {
  ProtocolEventAdapter,
  type ProtocolEventMessage,
} from "@langchain/langgraph-sdk/utils";

import { Composer } from "../../components/Composer";
import { EventLog } from "../../components/EventLog";
import { JsonPanel } from "../../components/JsonPanel";
import { MessageFeed } from "../../components/MessageFeed";
import type { PlaygroundTransportMode } from "../../components/ProtocolSwitcher";
import { createProtocolSessionClient } from "../../protocolSessionClient";
import { formatNamespace, isRecord } from "../../utils";
import {
  API_URL,
  getTransportLabel,
  summarizeToolEvent,
  useTraceLog,
} from "../shared";
import {
  createTraceEntry,
  getCanonicalSubagentNamespace,
  getLifecycleGraphName,
  getLifecycleStatus,
  getMessagesFromManager,
  getSortedSubagents,
  hasModelRequestActivity,
  isTerminalLifecycleStatus,
  type ModalState,
  resolveProtocolSubagentStatus,
  SESSION_ASSISTANT_ID,
  SUGGESTIONS,
  type SubagentRow,
} from "./common";

export function ProtocolParallelSubagentsView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const { eventLog, push } = useTraceLog();
  const clientRef = useRef<ReturnType<typeof createProtocolSessionClient> | null>(
    null
  );
  const activeModalRef = useRef<{
    token: string;
    unsubscribe: () => Promise<void>;
  } | null>(null);
  const nextSubagentOrderRef = useRef(1);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sessionState, setSessionState] = useState<
    "connecting" | "ready" | "closed"
  >("connecting");
  const [threadId, setThreadId] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [subagentsByKey, setSubagentsByKey] = useState<Record<string, SubagentRow>>(
    {}
  );
  const [modal, setModal] = useState<ModalState | null>(null);

  const closeModal = useCallback(async () => {
    const active = activeModalRef.current;
    activeModalRef.current = null;
    setModal(null);

    if (active != null) {
      await active.unsubscribe();
    }
  }, []);

  const handleSessionLifecycleEvent = useCallback(
    (event: ProtocolEventMessage) => {
      const namespace = [...event.params.namespace];
      const graphName = getLifecycleGraphName(event);
      const status = getLifecycleStatus(event);

      push(
        "lifecycle",
        namespace.length === 0 ? `Root ${status}` : `${graphName} ${status}`,
        `Namespace: ${formatNamespace(namespace)}`,
        {
          data: event.params.data,
          namespace,
        }
      );

      if (namespace.length === 0) {
        if (isTerminalLifecycleStatus(status)) {
          setIsSubmitting(false);
        }
        return;
      }

      const canonicalNamespace = getCanonicalSubagentNamespace(namespace);
      if (canonicalNamespace == null) {
        return;
      }

      const key = canonicalNamespace.join("|");
      setSubagentsByKey((current) => {
        const existing = current[key];
        const toolCallId =
          extractToolCallIdFromNamespace(canonicalNamespace) ?? key;
        const hasModelActivity = Boolean(
          existing?.hasModelActivity || hasModelRequestActivity(namespace)
        );
        return {
          ...current,
          [key]: {
            ...(existing ?? {
              graphName: `Worker ${nextSubagentOrderRef.current}`,
              order: nextSubagentOrderRef.current++,
              toolCallId,
              hasModelActivity: false,
            }),
            key,
            namespace: canonicalNamespace,
            status: resolveProtocolSubagentStatus(
              existing?.status,
              status,
              namespace,
              toolCallId
            ),
            eventCount: (existing?.eventCount ?? 0) + 1,
            hasModelActivity,
            graphName:
              existing?.graphName ??
              (graphName === "tools" || graphName === "model_request"
                ? `Worker ${nextSubagentOrderRef.current - 1}`
                : graphName),
          },
        };
      });

      setModal((current) =>
        current?.key === key
          ? {
              ...current,
              status: resolveProtocolSubagentStatus(
                current.status,
                status,
                namespace,
                extractToolCallIdFromNamespace(current.namespace) ?? current.key
              ),
            }
          : current
      );
    },
    [push]
  );

  useEffect(() => {
    let disposed = false;
    let unsubscribeLifecycle: (() => Promise<void>) | undefined;

    const client = createProtocolSessionClient(transportMode, {
      apiUrl: API_URL,
      assistantId: SESSION_ASSISTANT_ID,
    });
    clientRef.current = client;

    setSessionState("connecting");
    setError(null);
    setThreadId(null);
    setRunId(null);
    setIsSubmitting(false);
    setSubagentsByKey({});
    nextSubagentOrderRef.current = 1;
    setModal(null);
    activeModalRef.current = null;

    void (async () => {
      try {
        await client.open();
        if (disposed) {
          await client.close();
          return;
        }

        const subscription = await client.subscribe({
          channels: ["lifecycle"],
          onEvent: handleSessionLifecycleEvent,
        });

        if (disposed) {
          await subscription.unsubscribe();
          await client.close();
          return;
        }

        unsubscribeLifecycle = subscription.unsubscribe;
        setSessionState("ready");
      } catch (nextError) {
        if (disposed) return;
        setSessionState("closed");
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to initialize the protocol session."
        );
      }
    })();

    return () => {
      disposed = true;
      clientRef.current = null;
      setSessionState("closed");
      void (async () => {
        await closeModal();
        await unsubscribeLifecycle?.();
        await client.close();
      })();
    };
  }, [closeModal, handleSessionLifecycleEvent, transportMode]);

  const handleSubmit = useCallback(
    async (content: string) => {
      const client = clientRef.current;
      if (client == null) return;

      const nextThreadId = crypto.randomUUID();

      setError(null);
      setIsSubmitting(true);
      setThreadId(nextThreadId);
      setRunId(null);
      setSubagentsByKey({});
      nextSubagentOrderRef.current = 1;
      await closeModal();

      try {
        const response = await client.runInput({
          input: {
            messages: [{ content, type: "human" }],
          },
          config: {
            configurable: {
              thread_id: nextThreadId,
            },
          },
        });

        setRunId(response.runId);
      } catch (nextError) {
        setIsSubmitting(false);
        setError(
          nextError instanceof Error
            ? nextError.message
            : "Failed to submit the benchmark run."
        );
      }
    },
    [closeModal]
  );

  const handleOpenSubagent = useCallback(
    async (subagent: SubagentRow) => {
      const client = clientRef.current;
      if (client == null) return;

      await closeModal();

      const token = crypto.randomUUID();
      activeModalRef.current = {
        token,
        unsubscribe: async () => undefined,
      };

      const adapter = new ProtocolEventAdapter();
      const messageManager = new MessageTupleManager();
      const namespaceLabel = formatNamespace(subagent.namespace);

      setModal({
        key: subagent.key,
        namespace: subagent.namespace,
        graphName: subagent.graphName,
        status: subagent.status,
        messages: [],
        toolEvents: [],
        isConnecting: true,
      });

      try {
        const subscription = await client.subscribe({
          channels: ["messages", "tools"],
          namespaces: [subagent.namespace],
          onEvent: (event) => {
            if (activeModalRef.current?.token !== token) return;

            for (const adaptedEvent of adapter.adapt(event)) {
              if (
                adaptedEvent.event.startsWith("messages") &&
                Array.isArray(adaptedEvent.data)
              ) {
                const [chunk, metadata] = adaptedEvent.data as [
                  Message,
                  Record<string, unknown> | undefined,
                ];
                messageManager.add(
                  chunk,
                  isRecord(metadata) ? metadata : undefined
                );

                setModal((current) =>
                  current?.key === subagent.key
                    ? {
                        ...current,
                        messages: getMessagesFromManager(messageManager),
                      }
                    : current
                );
                continue;
              }

              if (adaptedEvent.event.startsWith("tools")) {
                const summary = summarizeToolEvent(adaptedEvent.data);
                const entry = createTraceEntry(
                  "tool",
                  summary.label,
                  `${summary.detail} Namespace: ${namespaceLabel}`,
                  adaptedEvent.data
                );

                setModal((current) =>
                  current?.key === subagent.key
                    ? {
                        ...current,
                        toolEvents: [entry, ...current.toolEvents].slice(0, 25),
                      }
                    : current
                );
                continue;
              }

              if (adaptedEvent.event === "error") {
                setModal((current) =>
                  current?.key === subagent.key
                    ? {
                        ...current,
                        error:
                          isRecord(adaptedEvent.data) &&
                          typeof adaptedEvent.data.message === "string"
                            ? adaptedEvent.data.message
                            : "Subagent activity stream failed.",
                      }
                    : current
                );
              }
            }
          },
        });

        if (activeModalRef.current?.token !== token) {
          await subscription.unsubscribe();
          return;
        }

        activeModalRef.current = {
          token,
          unsubscribe: subscription.unsubscribe,
        };

        setModal((current) =>
          current?.key === subagent.key
            ? {
                ...current,
                isConnecting: false,
              }
            : current
        );
      } catch (nextError) {
        if (activeModalRef.current?.token !== token) return;
        activeModalRef.current = null;
        setModal((current) =>
          current?.key === subagent.key
            ? {
                ...current,
                isConnecting: false,
                error:
                  nextError instanceof Error
                    ? nextError.message
                    : "Failed to subscribe to the subagent namespace.",
              }
            : current
        );
      }
    },
    [closeModal]
  );

  const subagents = useMemo(
    () => getSortedSubagents(subagentsByKey),
    [subagentsByKey]
  );

  const sessionSnapshot = useMemo(
    () => ({
      assistantId: SESSION_ASSISTANT_ID,
      apiUrl: API_URL,
      protocol: getTransportLabel(transportMode),
      sessionState,
      threadId,
      runId,
      discoveredSubagents: subagents.length,
      selectedNamespace: modal?.namespace ?? null,
      popupSubscriptionActive: modal != null,
    }),
    [modal, runId, sessionState, subagents.length, threadId, transportMode]
  );

  const modalTitleId = "parallel-subagent-activity-title";

  return (
    <>
      <section className="playground-shell">
        <header className="hero-card">
          <div>
            <div className="eyebrow">Protocol benchmark</div>
            <h2>Parallel Subagent Fan-Out</h2>
            <p>
              This QuickJS-backed Deep Agent keeps the base UI subscribed only to
              lifecycle events. Open a subagent on demand to attach a temporary
              namespace-scoped messages and tools subscription, then close it to
              stop receiving that worker&apos;s customer-poem activity.
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

        {error != null ? <div className="error-banner">{error}</div> : null}

        <div className="suggestion-row">
          {SUGGESTIONS.map((suggestion) => (
            <button
              key={suggestion}
              className="suggestion-chip"
              disabled={isSubmitting || sessionState !== "ready"}
              onClick={() => void handleSubmit(suggestion)}
              type="button"
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="parallel-grid">
          <section className="conversation-card">
            <div className="panel-card-header">
              <h3>Fan-Out Request</h3>
              <span className="conversation-status">
                {sessionState === "connecting"
                  ? "Connecting..."
                  : isSubmitting
                    ? "Streaming lifecycle..."
                    : "Ready"}
              </span>
            </div>

            <div className="empty-feed parallel-intro">
              <h3>Lifecycle-first benchmark</h3>
              <p>
                This view avoids a broad messages subscription until you click a
                subagent. That keeps the main surface light even when many workers
                are writing customer poems in parallel.
              </p>
            </div>

            <Composer
              disabled={isSubmitting || sessionState !== "ready"}
              onSubmit={(content) => void handleSubmit(content)}
              placeholder="Ask for poems for 8, 16, or all 100 customers so the coordinator fans out through QuickJS."
            />
          </section>

          <aside className="sidebar-stack">
            <section className="panel-card">
              <div className="panel-card-header">
                <h3>Discovered Subagents</h3>
                <span className="conversation-status">{subagents.length}</span>
              </div>

              {subagents.length === 0 ? (
                <div className="empty-panel">
                  Lifecycle events will populate this list as soon as the
                  benchmark coordinator starts spawning customer-poet workers.
                </div>
              ) : (
                <div className="parallel-subagent-list">
                  {subagents.map((subagent) => (
                    <button
                      key={subagent.key}
                      className="parallel-subagent-button"
                      onClick={() => void handleOpenSubagent(subagent)}
                      type="button"
                    >
                      <div className="subagent-header">
                        <strong>{subagent.graphName}</strong>
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
                        Tool call: {subagent.toolCallId}
                      </div>
                      <div className="subagent-meta">
                        {subagent.eventCount} lifecycle event
                        {subagent.eventCount === 1 ? "" : "s"} seen
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <JsonPanel title="Session Snapshot" value={sessionSnapshot} />
            <EventLog eventLog={eventLog} />
          </aside>
        </div>
      </section>

      {modal != null ? (
        <div
          className="parallel-modal-backdrop"
          onClick={(event: MouseEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            void closeModal();
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
                <h3 id={modalTitleId}>{modal.graphName}</h3>
                <div className="subagent-meta">
                  Namespace: {formatNamespace(modal.namespace)}
                </div>
              </div>
              <div className="parallel-modal-actions">
                {modal.isConnecting ? (
                  <span className="conversation-status">Subscribing...</span>
                ) : null}
                <span className={`status-pill status-${modal.status.toLowerCase()}`}>
                  {modal.status}
                </span>
                <button
                  className="secondary-button"
                  onClick={() => void closeModal()}
                  type="button"
                >
                  Close popup
                </button>
              </div>
            </div>

            {modal.error != null ? (
              <div className="error-banner">{modal.error}</div>
            ) : null}

            <div className="parallel-modal-grid">
              <section className="panel-card">
                <div className="panel-card-header">
                  <h3>Messages</h3>
                  <span className="conversation-status">
                    {modal.messages.length} total
                  </span>
                </div>
                <MessageFeed messages={modal.messages} />
              </section>

              <EventLog eventLog={modal.toolEvents} />
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
