import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Message } from "@langchain/langgraph-sdk";
import { useStream } from "@langchain/langgraph-sdk/react";

import type { agent as createAgentType } from "./agents/create-agent";
import type { agent as deepAgentType } from "./agents/deep-agent";
import type { agent as stategraphAgentType } from "./agents/basic-stategraph";
import {
  ProtocolPlayground,
  type SubagentCardData,
  type TraceEntry,
} from "./components/ProtocolPlayground";
import {
  createProtocolTransport,
  type ProtocolTransportMode,
} from "./protocolTransport";

const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL ?? "http://localhost:2024";

type TabId = "stategraph" | "create-agent" | "deep-agent";

const TABS: Array<{
  id: TabId;
  title: string;
  blurb: string;
}> = [
  {
    id: "stategraph",
    title: "StateGraph",
    blurb: "Basic graph loop with explicit tool routing.",
  },
  {
    id: "create-agent",
    title: "createAgent",
    blurb: "Single-agent runtime using the LangChain helper.",
  },
  {
    id: "deep-agent",
    title: "Deep Agent",
    blurb: "Coordinator plus three protocol-focused subagents.",
  },
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const formatNamespace = (namespace?: string[]) =>
  namespace != null && namespace.length > 0 ? namespace.join(" / ") : "root";

const getMessagePreview = (messages: Message[]) => {
  const lastMessage = [...messages].reverse().find((message) => {
    if (typeof message.content === "string") return message.content.trim().length > 0;
    if (!Array.isArray(message.content)) return false;
    return message.content.some(
      (block) =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        block.text.trim().length > 0
    );
  });

  if (lastMessage == null) return "";
  if (typeof lastMessage.content === "string") return lastMessage.content;
  if (!Array.isArray(lastMessage.content)) return "";
  return lastMessage.content
    .filter(
      (block): block is { type: "text"; text: string } =>
        isRecord(block) &&
        block.type === "text" &&
        typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");
};

const getLastAssistantMetadata = <TMessage extends Message>(
  messages: TMessage[],
  getMessagesMetadata?: (message: TMessage) => unknown
) => {
  if (getMessagesMetadata == null) return undefined;
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.type === "ai");
  return lastAssistant != null ? getMessagesMetadata(lastAssistant) : undefined;
};

const summarizeToolEvent = (data: unknown) => {
  if (!isRecord(data) || typeof data.event !== "string") {
    return {
      label: "Tool event",
      detail: "Received a tool lifecycle event.",
    };
  }

  switch (data.event) {
    case "on_tool_start":
      return {
        label:
          typeof data.name === "string"
            ? `Started ${data.name}`
            : "Started tool",
        detail: "The tool call has started.",
      };
    case "on_tool_end":
      return {
        label:
          typeof data.name === "string"
            ? `Finished ${data.name}`
            : "Finished tool",
        detail: "The tool call completed successfully.",
      };
    case "on_tool_error":
      return {
        label:
          typeof data.name === "string" ? `Errored ${data.name}` : "Tool error",
        detail:
          typeof data.error === "string" ? data.error : "The tool call failed.",
      };
    case "on_tool_event":
      return {
        label:
          typeof data.name === "string"
            ? `Updated ${data.name}`
            : "Tool update",
        detail: "The tool emitted an intermediate event.",
      };
    default:
      return {
        label: "Tool event",
        detail: `Received ${data.event}.`,
      };
  }
};

const summarizeUpdateEvent = (data: unknown, namespace?: string[]) => {
  if (isRecord(data)) {
    const keys = Object.keys(data);
    return {
      label: `Updated ${keys.length > 0 ? keys.join(", ") : "state"}`,
      detail: `Namespace: ${formatNamespace(namespace)}`,
    };
  }

  return {
    label: "Updated state",
    detail: `Namespace: ${formatNamespace(namespace)}`,
  };
};

const getTransportLabel = (mode: ProtocolTransportMode) =>
  mode === "websocket" ? "websocket" : "http+sse";

function useTraceLog() {
  const [eventLog, setEventLog] = useState<TraceEntry[]>([]);

  const push = useCallback(
    (kind: string, label: string, detail: string, raw: unknown) => {
      const next: TraceEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind,
        label,
        detail,
        timestamp: new Date().toLocaleTimeString(),
        raw,
      };

      setEventLog((previous) => [next, ...previous].slice(0, 20));
    },
    []
  );

  return { eventLog, push };
}

function StateGraphView({
  transportMode,
}: {
  transportMode: ProtocolTransportMode;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const transport = useMemo(
    () =>
      createProtocolTransport(transportMode, {
        apiUrl: API_URL,
        assistantId: "stategraph",
      }),
    [transportMode]
  );

  const stream = useStream<typeof stategraphAgentType>({
    transport,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input);
    },
    [stream]
  );

  return (
    <ProtocolPlayground
      apiUrl={API_URL}
      assistantId="stategraph"
      description="This view drives a compiled StateGraph through the new session-based SSE transport."
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder="Ask the graph to explain a protocol feature or sketch a test checklist."
      protocolLabel={getTransportLabel(transportMode)}
      suggestions={[
        "Explain how session.open and subscription.subscribe fit together.",
        "Create a quick checklist for validating message and tool streaming.",
      ]}
      threadId={threadId}
      title="Basic StateGraph"
      values={stream.values}
    />
  );
}

function CreateAgentView({
  transportMode,
}: {
  transportMode: ProtocolTransportMode;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const transport = useMemo(
    () =>
      createProtocolTransport(transportMode, {
        apiUrl: API_URL,
        assistantId: "create-agent",
      }),
    [transportMode]
  );

  const stream = useStream<typeof createAgentType>({
    transport,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input);
    },
    [stream]
  );

  return (
    <ProtocolPlayground
      apiUrl={API_URL}
      assistantId="create-agent"
      description="This view uses createAgent from langchain while the client opts into streamProtocol=v2-sse."
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder="Ask the agent to compare protocol features, build a plan, or review risks."
      protocolLabel={getTransportLabel(transportMode)}
      suggestions={[
        "Compare the new protocol to the legacy stream from a frontend perspective.",
        "Review likely rough edges when wiring a React client to v2-sse.",
      ]}
      threadId={threadId}
      title="createAgent Runtime"
      values={stream.values}
    />
  );
}

function DeepAgentView({
  transportMode,
}: {
  transportMode: ProtocolTransportMode;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const transport = useMemo(
    () =>
      createProtocolTransport(transportMode, {
        apiUrl: API_URL,
        assistantId: "deep-agent",
      }),
    [transportMode]
  );

  const stream = useStream<typeof deepAgentType>({
    transport,
    filterSubagentMessages: true,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  console.log(11, stream.subagents)
  const subagentDebug = useMemo(() => {
    const entries = Array.from(
      stream.subagents.entries() as Iterable<[string, unknown]>
    );

    return entries.map(([id, subagent]) => {
      const state = subagent as unknown as {
        status?: string;
        messages?: Message[];
        namespace?: string[];
        values?: Record<string, unknown>;
        toolCall?: {
          name?: string;
          args?: Record<string, unknown>;
        };
      };
      const snapshotMessages = Array.isArray(state.values?.messages)
        ? (state.values.messages as Message[])
        : [];

      return {
        id,
        status: state.status ?? "unknown",
        namespace: state.namespace ?? [],
        toolName: state.toolCall?.name,
        toolArgs: state.toolCall?.args,
        messageCount: state.messages?.length ?? 0,
        snapshotMessageCount: snapshotMessages.length,
        preview:
          state.messages != null ? getMessagePreview(state.messages) : undefined,
        snapshotPreview:
          snapshotMessages.length > 0 ? getMessagePreview(snapshotMessages) : undefined,
      };
    });
  }, [stream.subagents]);

  const subagents = useMemo<SubagentCardData[]>(
    () =>
      subagentDebug.map((subagent) => ({
        id: subagent.id,
        title: subagent.id,
        status: subagent.status,
        messageCount: subagent.messageCount,
        preview: subagent.preview,
      })),
    [subagentDebug]
  );

  const lastSubagentTraceRef = useRef("");
  useEffect(() => {
    if (subagentDebug.length === 0) return;

    const snapshot = JSON.stringify(subagentDebug);
    if (snapshot === lastSubagentTraceRef.current) return;
    lastSubagentTraceRef.current = snapshot;

    const detail = subagentDebug
      .map(
        (subagent) =>
          `${subagent.id}:${subagent.status}:stream=${subagent.messageCount}:snapshot=${subagent.snapshotMessageCount}`
      )
      .join(" | ");

    console.log(
      "[deep-agent subagent snapshot]",
      JSON.stringify({
        detail,
        subagents: subagentDebug,
      })
    );
  }, [subagentDebug]);

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(
        input,
        { streamSubgraphs: true }
      );
    },
    [stream]
  );

  return (
    <ProtocolPlayground
      apiUrl={API_URL}
      assistantId="deep-agent"
      description="This view exercises a Deep Agent with three subagents so you can inspect hierarchical streaming over the new protocol."
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder="Ask for a research, planning, and risk-review pass so the coordinator fans work out to subagents."
      protocolLabel={getTransportLabel(transportMode)}
      subagents={subagents}
      suggestions={[
        "Break down a protocol smoke test plan across research, planning, and risk review.",
        "Analyze how a Deep Agent frontend should display lifecycle and reconnect behavior.",
      ]}
      threadId={threadId}
      title="Deep Agent Runtime"
      values={stream.values}
    />
  );
}

export function App() {
  const [activeTab, setActiveTab] = useState<TabId>("stategraph");
  const [transportMode, setTransportMode] =
    useState<ProtocolTransportMode>("http-sse");
  const activeViewKey = `${activeTab}:${transportMode}`;

  return (
    <main className="app-shell">
      <header className="app-header">
        <div>
          <div className="eyebrow">LangGraph protocol playground</div>
          <h1>New Protocol Testbed</h1>
          <p className="app-subtitle">
            Compare a StateGraph, a createAgent runtime, and a Deep Agent while
            the frontend streams through the new LangGraph API protocol over
            either HTTP+SSE or WebSocket.
          </p>
        </div>
        <div className="header-badges">
          <span className="header-badge">API: {API_URL}</span>
          <div className="transport-toggle" role="group" aria-label="Transport">
            <button
              className={`transport-button ${
                transportMode === "http-sse" ? "transport-button-active" : ""
              }`}
              onClick={() => setTransportMode("http-sse")}
              type="button"
            >
              HTTP+SSE
            </button>
            <button
              className={`transport-button ${
                transportMode === "websocket" ? "transport-button-active" : ""
              }`}
              onClick={() => setTransportMode("websocket")}
              type="button"
            >
              WebSocket
            </button>
          </div>
        </div>
      </header>

      <nav className="tab-row" aria-label="Protocol example views">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={`tab-button ${activeTab === tab.id ? "tab-button-active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
            type="button"
          >
            <span>{tab.title}</span>
            <small>{tab.blurb}</small>
          </button>
        ))}
      </nav>

      {activeTab === "stategraph" ? (
        <StateGraphView key={activeViewKey} transportMode={transportMode} />
      ) : null}
      {activeTab === "create-agent" ? (
        <CreateAgentView key={activeViewKey} transportMode={transportMode} />
      ) : null}
      {activeTab === "deep-agent" ? (
        <DeepAgentView key={activeViewKey} transportMode={transportMode} />
      ) : null}
    </main>
  );
}
