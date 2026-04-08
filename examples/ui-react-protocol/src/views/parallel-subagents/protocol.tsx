import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
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
  createSyntheticToolResultMessage,
  createTraceEntry,
  getCanonicalSubagentNamespace,
  getLifecycleGraphName,
  getLifecycleStatus,
  getMessagesFromManager,
  getSortedSubagents,
  hasModelRequestActivity,
  isToolCallNamespace,
  isToolExecutionNamespace,
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
  const activeInspectorRef = useRef<{
    token: string;
    unsubscribe: () => Promise<void>;
  } | null>(null);
  const nextSubagentOrderRef = useRef(1);
  const orchestratorAdapterRef = useRef(new ProtocolEventAdapter());
  const orchestratorMessageManagerRef = useRef(new MessageTupleManager());

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
  const [inspector, setInspector] = useState<ModalState | null>(null);
  const [orchestratorMessages, setOrchestratorMessages] = useState<Message[]>([]);
  const [orchestratorToolEvents, setOrchestratorToolEvents] = useState<
    ReturnType<typeof useTraceLog>["eventLog"]
  >([]);

  const resetOrchestratorMessages = useCallback(() => {
    orchestratorAdapterRef.current = new ProtocolEventAdapter();
    orchestratorMessageManagerRef.current = new MessageTupleManager();
    setOrchestratorMessages([]);
    setOrchestratorToolEvents([]);
  }, []);

  const closeInspector = useCallback(async () => {
    const active = activeInspectorRef.current;
    activeInspectorRef.current = null;
    setInspector(null);

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

      setInspector((current) =>
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
    let unsubscribeOrchestrator: (() => Promise<void>) | undefined;

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
    setInspector(null);
    activeInspectorRef.current = null;
    resetOrchestratorMessages();

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

        const orchestratorSubscription = await client.subscribe({
          channels: ["messages", "tools"],
          namespaces: [[]],
          depth: 1,
          onEvent: (event) => {
            const namespace = [...event.params.namespace];
            const isToolExecutionMessage =
              event.method === "messages" && isToolExecutionNamespace(namespace);
            const canonicalNamespace = getCanonicalSubagentNamespace(namespace);
            const toolCallId =
              canonicalNamespace != null
                ? extractToolCallIdFromNamespace(canonicalNamespace)
                : undefined;
            const isNestedWorkerNamespace =
              canonicalNamespace != null &&
              namespace.length > 1 &&
              toolCallId != null &&
              isToolCallNamespace(toolCallId);

            if (isNestedWorkerNamespace) {
              return;
            }

            for (const adaptedEvent of orchestratorAdapterRef.current.adapt(event)) {
              if (
                adaptedEvent.event.startsWith("messages") &&
                Array.isArray(adaptedEvent.data)
              ) {
                if (isToolExecutionMessage) {
                  continue;
                }
                const [chunk, metadata] = adaptedEvent.data as [
                  Message,
                  Record<string, unknown> | undefined,
                ];
                orchestratorMessageManagerRef.current.add(
                  chunk,
                  isRecord(metadata) ? metadata : undefined
                );
                setOrchestratorMessages(
                  getMessagesFromManager(orchestratorMessageManagerRef.current)
                );
                continue;
              }

              if (adaptedEvent.event.startsWith("tools")) {
                const syntheticMessage = createSyntheticToolResultMessage(
                  adaptedEvent.data
                );
                if (syntheticMessage != null) {
                  orchestratorMessageManagerRef.current.add(syntheticMessage, {
                    langgraph_checkpoint_ns: namespace.join("|"),
                    langgraph_node: "tools",
                  });
                  setOrchestratorMessages(
                    getMessagesFromManager(orchestratorMessageManagerRef.current)
                  );
                }

                const summary = summarizeToolEvent(adaptedEvent.data);
                const entry = createTraceEntry(
                  "tool",
                  summary.label,
                  `${summary.detail} Namespace: ${formatNamespace(namespace)}`,
                  adaptedEvent.data
                );
                setOrchestratorToolEvents((current) => [entry, ...current].slice(0, 25));
              }
            }
          },
        });

        if (disposed) {
          await orchestratorSubscription.unsubscribe();
          await subscription.unsubscribe();
          await client.close();
          return;
        }

        unsubscribeLifecycle = subscription.unsubscribe;
        unsubscribeOrchestrator = orchestratorSubscription.unsubscribe;
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
        await closeInspector();
        await unsubscribeLifecycle?.();
        await unsubscribeOrchestrator?.();
        await client.close();
      })();
    };
  }, [
    closeInspector,
    handleSessionLifecycleEvent,
    resetOrchestratorMessages,
    transportMode,
  ]);

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
      resetOrchestratorMessages();
      await closeInspector();

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
    [closeInspector, resetOrchestratorMessages]
  );

  const handleOpenSubagent = useCallback(
    async (subagent: SubagentRow) => {
      const client = clientRef.current;
      if (client == null) return;

      await closeInspector();

      const token = crypto.randomUUID();
      activeInspectorRef.current = {
        token,
        unsubscribe: async () => undefined,
      };

      const adapter = new ProtocolEventAdapter();
      const messageManager = new MessageTupleManager();
      const namespaceLabel = formatNamespace(subagent.namespace);

      setInspector({
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
            if (activeInspectorRef.current?.token !== token) return;
            const namespace = [...event.params.namespace];
            const isToolExecutionMessage =
              event.method === "messages" && isToolExecutionNamespace(namespace);

            for (const adaptedEvent of adapter.adapt(event)) {
              if (
                adaptedEvent.event.startsWith("messages") &&
                Array.isArray(adaptedEvent.data)
              ) {
                if (isToolExecutionMessage) {
                  continue;
                }
                const [chunk, metadata] = adaptedEvent.data as [
                  Message,
                  Record<string, unknown> | undefined,
                ];
                messageManager.add(
                  chunk,
                  isRecord(metadata) ? metadata : undefined
                );

                setInspector((current) =>
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
                const syntheticMessage = createSyntheticToolResultMessage(
                  adaptedEvent.data
                );
                if (syntheticMessage != null) {
                  messageManager.add(syntheticMessage, {
                    langgraph_checkpoint_ns: namespace.join("|"),
                    langgraph_node: "tools",
                  });
                  setInspector((current) =>
                    current?.key === subagent.key
                      ? {
                          ...current,
                          messages: getMessagesFromManager(messageManager),
                        }
                      : current
                  );
                }

                const summary = summarizeToolEvent(adaptedEvent.data);
                const entry = createTraceEntry(
                  "tool",
                  summary.label,
                  `${summary.detail} Namespace: ${namespaceLabel}`,
                  adaptedEvent.data
                );

                setInspector((current) =>
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
                setInspector((current) =>
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

        if (activeInspectorRef.current?.token !== token) {
          await subscription.unsubscribe();
          return;
        }

        activeInspectorRef.current = {
          token,
          unsubscribe: subscription.unsubscribe,
        };

        setInspector((current) =>
          current?.key === subagent.key
            ? {
                ...current,
                isConnecting: false,
              }
            : current
        );
      } catch (nextError) {
        if (activeInspectorRef.current?.token !== token) return;
        activeInspectorRef.current = null;
        setInspector((current) =>
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
    [closeInspector]
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
      orchestratorMessageCount: orchestratorMessages.length,
      orchestratorToolEventCount: orchestratorToolEvents.length,
      discoveredSubagents: subagents.length,
      selectedNamespace: inspector?.namespace ?? null,
      inspectorSubscriptionActive: inspector != null,
    }),
    [
      inspector,
      orchestratorMessages.length,
      orchestratorToolEvents.length,
      runId,
      sessionState,
      subagents.length,
      threadId,
      transportMode,
    ]
  );
  const isInspectingSubagent = inspector != null;
  const orchestratorStatusLabel =
    sessionState === "connecting"
      ? "Connecting..."
      : isSubmitting
        ? "Streaming orchestrator..."
        : "Ready";

  return (
    <section className="playground-shell">
      <header className="hero-card">
        <div>
          <div className="eyebrow">Protocol benchmark</div>
          <h2>Parallel Subagent Fan-Out</h2>
          <p>
            This QuickJS-backed Deep Agent now keeps the main panel focused on the
            orchestrator&apos;s root messages, then swaps that same inspector over to
            a subagent when you click one in the discovered-worker list.
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
            <div>
              <h3>{inspector?.graphName ?? "Fan-Out Request"}</h3>
              <div className="subagent-meta">
                {isInspectingSubagent
                  ? `Namespace: ${formatNamespace(inspector.namespace)}`
                  : "Root namespace only. Click a worker to replace this panel with that subagent's live activity."}
              </div>
            </div>
            <div className="parallel-inline-actions">
              {isInspectingSubagent ? (
                <>
                  {inspector.isConnecting ? (
                    <span className="conversation-status">Subscribing...</span>
                  ) : null}
                  <span
                    className={`status-pill status-${inspector.status.toLowerCase()}`}
                  >
                    {inspector.status}
                  </span>
                  <button
                    className="secondary-button"
                    onClick={() => void closeInspector()}
                    type="button"
                  >
                    Back to orchestrator
                  </button>
                </>
              ) : (
                <span className="conversation-status">{orchestratorStatusLabel}</span>
              )}
            </div>
          </div>

          {inspector?.error != null ? (
            <div className="error-banner">{inspector.error}</div>
          ) : null}

          {isInspectingSubagent ? (
            <div className="parallel-inline-grid">
              <section className="panel-card parallel-inline-panel">
                <div className="panel-card-header">
                  <h3>Messages</h3>
                  <span className="conversation-status">
                    {inspector.messages.length} total
                  </span>
                </div>
                <MessageFeed messages={inspector.messages} />
              </section>

              <EventLog eventLog={inspector.toolEvents} />
            </div>
          ) : (
            <>
              <div className="empty-feed parallel-intro">
                <h3>Root orchestrator stream</h3>
                <p>
                  The center panel stays attached to the coordinator&apos;s
                  non-worker protocol traffic, so you can see its prompts,
                  tool-call messages, js-eval activity, and final summary without
                  opening anything else.
                </p>
              </div>
              <div className="parallel-inline-grid">
                <section className="panel-card parallel-inline-panel">
                  <div className="panel-card-header">
                    <h3>Messages</h3>
                    <span className="conversation-status">
                      {orchestratorMessages.length} total
                    </span>
                  </div>
                  <MessageFeed messages={orchestratorMessages} />
                </section>

                <EventLog eventLog={orchestratorToolEvents} />
              </div>
            </>
          )}

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
                Lifecycle events will populate this list as soon as the benchmark
                coordinator starts spawning customer-poet workers.
              </div>
            ) : (
              <div className="parallel-subagent-list">
                {subagents.map((subagent) => (
                  <button
                    key={subagent.key}
                    className={`parallel-subagent-button${
                      inspector?.key === subagent.key ? " is-active" : ""
                    }`}
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
  );
}
