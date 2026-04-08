import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";
import {
  extractToolCallIdFromNamespace,
  MessageTupleManager,
  toMessageDict,
} from "@langchain/langgraph-sdk/ui";
import {
  ProtocolEventAdapter,
  type ProtocolEventMessage,
} from "@langchain/langgraph-sdk/utils";

import { Composer } from "../components/Composer";
import { EventLog } from "../components/EventLog";
import { JsonPanel } from "../components/JsonPanel";
import { MessageFeed } from "../components/MessageFeed";
import type { TraceEntry } from "../components/ProtocolPlayground";
import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import type { agent as parallelAgentType } from "../agents/parallel-subagents";
import { createProtocolSessionClient } from "../protocolSessionClient";
import {
  formatNamespace,
  getLastAssistantMetadata,
  getSubagentPreview,
  isRecord,
} from "../utils";
import {
  API_URL,
  getTransportLabel,
  isProtocolTransportMode,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "./shared";

type SubagentRow = {
  key: string;
  namespace: string[];
  graphName: string;
  status: string;
  eventCount: number;
  hasModelActivity: boolean;
  order: number;
  toolCallId: string;
};

type ModalState = {
  key: string;
  namespace: string[];
  graphName: string;
  status: string;
  messages: Message[];
  toolEvents: TraceEntry[];
  isConnecting: boolean;
  error?: string;
};

const SESSION_ASSISTANT_ID = "parallel-subagents";

const SUGGESTIONS = [
  "Write short poems for the first 8 customers in the CSV fixture.",
  "Write short poems for the first 16 customers and summarize the fan-out.",
  "Write a tiny poem for every customer in the 100-row fixture.",
];

const createTraceEntry = (
  kind: string,
  label: string,
  detail: string,
  raw: unknown
): TraceEntry => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  kind,
  label,
  detail,
  timestamp: new Date().toLocaleTimeString(),
  raw,
});

const getMessagesFromManager = (manager: MessageTupleManager) =>
  Object.values(manager.chunks)
    .filter(
      (
        entry
      ): entry is {
        chunk: Parameters<typeof toMessageDict>[0];
      } => entry.chunk != null
    )
    .map((entry) => toMessageDict(entry.chunk) as Message);

const getLifecycleStatus = (event: ProtocolEventMessage) => {
  const data = event.params.data;
  return isRecord(data) && typeof data.event === "string" ? data.event : "running";
};

const getLifecycleGraphName = (event: ProtocolEventMessage) => {
  const data = event.params.data;
  if (isRecord(data) && typeof data.graphName === "string") {
    return data.graphName;
  }

  return event.params.namespace.at(-1) ?? "subagent";
};

const getCanonicalSubagentNamespace = (namespace: string[]) => {
  let lastToolIndex = -1;
  for (let index = 0; index < namespace.length; index += 1) {
    if (namespace[index]?.startsWith("tools:")) {
      lastToolIndex = index;
    }
  }
  return lastToolIndex === -1 ? null : namespace.slice(0, lastToolIndex + 1);
};

const hasModelRequestActivity = (namespace: string[]) =>
  namespace.some((segment) => segment.startsWith("model_request:"));

const isNamespacePrefix = (prefix: string[], namespace?: string[]) => {
  if (namespace == null) return false;
  return prefix.every((segment, index) => namespace[index] === segment);
};

const getLegacySubagentTitle = (
  toolCallId: string,
  toolCall?: {
    args?: Record<string, unknown>;
  }
) => {
  const args = toolCall?.args;
  const firstName =
    typeof args?.firstName === "string" ? args.firstName : undefined;
  const lastName =
    typeof args?.lastName === "string" ? args.lastName : undefined;
  if (firstName || lastName) {
    return [firstName, lastName].filter(Boolean).join(" ");
  }

  if (typeof args?.customerName === "string") {
    return args.customerName;
  }

  if (typeof args?.description === "string") {
    return args.description.length > 48
      ? `${args.description.slice(0, 45)}...`
      : args.description;
  }

  return toolCallId;
};

const getSortedSubagents = (subagents: Record<string, SubagentRow>) =>
  Object.values(subagents)
    .filter((subagent) => subagent.hasModelActivity)
    .sort((left, right) => {
      if (left.status === right.status) {
        return left.order - right.order;
      }

      if (left.status === "running") return -1;
      if (right.status === "running") return 1;
      return left.status.localeCompare(right.status);
    });

export function ParallelSubagentsView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolParallelSubagentsView transportMode={transportMode} />
  ) : (
    <LegacyParallelSubagentsView />
  );
}

function LegacyParallelSubagentsView() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [modalToolCallId, setModalToolCallId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const [toolEvents, setToolEvents] = useState<
    Array<TraceEntry & { namespace?: string[] }>
  >([]);

  const stream = useStream<typeof parallelAgentType>({
    assistantId: SESSION_ASSISTANT_ID,
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: "legacy",
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
        messages?: Message[];
        namespace?: string[];
        values?: Record<string, unknown>;
        toolCall?: {
          args?: Record<string, unknown>;
        };
      };
      const snapshotMessages = Array.isArray(state.values?.messages)
        ? (state.values.messages as Message[])
        : [];
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

  const modalTitleId = "parallel-subagent-legacy-activity-title";

  return (
    <>
      <section className="playground-shell">
        <header className="hero-card">
          <div>
            <div className="eyebrow">Protocol benchmark</div>
            <h2>Parallel Subagent Fan-Out</h2>
            <p>
              This legacy variant streams all of the deep-agent traffic through
              the original transport. It does not support namespace unsubscribe,
              so large fan-out runs can overwhelm the client with customer-poem
              messages and tool chatter.
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
              <dd>{getTransportLabel("legacy")}</dd>
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
              : "The legacy stream failed."}
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
              <h3>Legacy Firehose</h3>
              <span className="conversation-status">
                {stream.isLoading ? "Streaming everything..." : "Idle"}
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
              placeholder="Ask for poems for 8, 16, or all 100 customers and watch the legacy stream flood the client."
            />
          </section>

          <aside className="sidebar-stack">
            <section className="panel-card">
              <div className="panel-card-header">
                <h3>Tracked Subagents</h3>
                <span className="conversation-status">{subagents.length}</span>
              </div>

              {subagents.length === 0 ? (
                <div className="empty-panel">
                  Start a legacy run to inspect how many customer-poet subagents
                  get reconstructed from the firehose.
                </div>
              ) : (
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
              )}
            </section>

            <JsonPanel
              title="Legacy Snapshot"
              value={{
                assistantId: SESSION_ASSISTANT_ID,
                protocol: getTransportLabel("legacy"),
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

function ProtocolParallelSubagentsView({
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

  const handleLifecycleEvent = useCallback(
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
        if (
          status === "completed" ||
          status === "failed" ||
          status === "interrupted"
        ) {
          setIsSubmitting(false);
        }
        return;
      }

      const canonicalNamespace = getCanonicalSubagentNamespace(namespace);
      if (canonicalNamespace == null) {
        return;
      }

      const key = canonicalNamespace.join("|");
      const modelActivity = hasModelRequestActivity(namespace);
      setSubagentsByKey((current) => ({
        ...current,
        [key]: {
          ...(current[key] ?? {
            graphName: `Worker ${nextSubagentOrderRef.current}`,
            order: nextSubagentOrderRef.current++,
            toolCallId: extractToolCallIdFromNamespace(canonicalNamespace) ?? key,
            hasModelActivity: false,
          }),
          key,
          namespace: canonicalNamespace,
          status: modelActivity ? "running" : (current[key]?.status ?? status),
          eventCount: (current[key]?.eventCount ?? 0) + 1,
          hasModelActivity: Boolean(current[key]?.hasModelActivity || modelActivity),
          graphName:
            current[key]?.graphName ??
            (graphName === "tools" || graphName === "model_request"
              ? `Worker ${nextSubagentOrderRef.current - 1}`
              : graphName),
        },
      }));

      setModal((current) =>
        current?.key === key
          ? {
              ...current,
              status:
                current.status === "spawned" && modelActivity ? "running" : current.status,
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
          onEvent: handleLifecycleEvent,
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
  }, [closeModal, handleLifecycleEvent, transportMode]);

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
