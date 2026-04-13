import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { BaseMessage } from "@langchain/core/messages";
import { useStream } from "@langchain/react";

import type { agent as deepAgentType } from "../agents/deep-agent";
import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import {
  ProtocolPlayground,
  type SubagentCardData,
  type TraceEntry,
} from "../components/ProtocolPlayground";
import {
  ensureBaseMessages,
  formatNamespace,
  getLastAssistantMetadata,
  getTextContent,
  getSubagentPreview,
} from "../utils";
import {
  API_URL,
  getTransportLabel,
  getStreamProtocol,
  isProtocolTransportMode,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "./shared";

const getDisplaySubagentStatus = ({
  status,
  result,
  error,
}: {
  status?: string;
  result?: unknown;
  error?: unknown;
}) => {
  if (error != null) return "failed";
  if (result != null) return "completed";
  return status === "complete" ? "completed" : (status ?? "unknown");
};

const getToolEventCallId = (data: unknown) =>
  typeof (data as { toolCallId?: unknown })?.toolCallId === "string"
    ? (data as { toolCallId: string }).toolCallId
    : undefined;

const getToolEventName = (data: unknown) =>
  typeof (data as { event?: unknown })?.event === "string"
    ? (data as { event: string }).event
    : undefined;

const getUpdateKeys = (data: unknown) =>
  data != null && typeof data === "object" ? Object.keys(data) : [];

const summarizeDebugMessages = (messages: BaseMessage[] | undefined) =>
  (messages ?? []).map((message) => {
    const maybeToolCalls = message as {
      tool_calls?: Array<{ id?: string; name?: string }>;
    };
    return {
      id: message.id ?? null,
      type: message.type,
      text: getTextContent(message).slice(0, 120),
      toolCallCount: Array.isArray(maybeToolCalls.tool_calls)
        ? maybeToolCalls.tool_calls.length
        : 0,
      toolCallNames: Array.isArray(maybeToolCalls.tool_calls)
        ? maybeToolCalls.tool_calls.map((toolCall) => toolCall.name ?? "")
        : [],
    };
  });

export function DeepAgentView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolDeepAgentView transportMode={transportMode} />
  ) : (
    <LegacyDeepAgentView />
  );
}

function LegacyDeepAgentView() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const stream = useStream<typeof deepAgentType>({
    assistantId: "deep-agent",
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: "legacy",
    throttle: true,
    threadId,
    onThreadId: setThreadId,
    onToolEvent: (data, options) => {
      const summary = summarizeToolEvent(data);
      if (options.namespace?.length) {
        console.log(
          "[deep-agent protocol tool event]",
          JSON.stringify({
            event: getToolEventName(data),
            toolCallId: getToolEventCallId(data),
            namespace: options.namespace,
            namespaceLabel: formatNamespace(options.namespace),
            data,
          })
        );
      }
      push("tool", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
    onUpdateEvent: (data, options) => {
      const summary = summarizeUpdateEvent(data, options.namespace);
      if (options.namespace?.length) {
        console.log(
          "[deep-agent protocol update event]",
          JSON.stringify({
            namespace: options.namespace,
            namespaceLabel: formatNamespace(options.namespace),
            keys: getUpdateKeys(data),
          })
        );
      }
      push("update", summary.label, summary.detail, {
        data,
        namespace: options.namespace,
      });
    },
  });

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input, { streamSubgraphs: true });
    },
    [stream]
  );

  return (
    <DeepAgentPlayground
      description="This view exercises a Deep Agent over the same legacy streaming path used by the standard React examples."
      eventLog={eventLog}
      onSubmit={handleSubmit}
      protocolLabel={getTransportLabel("legacy")}
      stream={stream}
      threadId={threadId}
    />
  );
}

function ProtocolDeepAgentView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();

  const stream = useStream<typeof deepAgentType>({
    assistantId: "deep-agent",
    apiUrl: API_URL,
    fetchStateHistory: true,
    filterSubagentMessages: true,
    streamProtocol: getStreamProtocol(transportMode),
    throttle: true,
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

  const handleSubmit = useCallback(
    (content: string) => {
      const input = {
        messages: [{ content, type: "human" }],
      } as Parameters<typeof stream.submit>[0];
      stream.submit(input, { streamSubgraphs: true });
    },
    [stream]
  );

  return (
    <DeepAgentPlayground
      description="This view exercises a Deep Agent with four poetry subagents so you can inspect hierarchical streaming over the new protocol."
      eventLog={eventLog}
      onSubmit={handleSubmit}
      protocolLabel={getTransportLabel(transportMode)}
      stream={stream}
      threadId={threadId}
    />
  );
}

function DeepAgentPlayground({
  stream,
  threadId,
  protocolLabel,
  description,
  eventLog,
  onSubmit,
}: {
  stream: {
    messages: BaseMessage[];
    getMessagesMetadata?: (message: BaseMessage) => unknown;
    isLoading: boolean;
    subagents: {
      entries(): IterableIterator<[string, unknown]>;
    };
    values: Record<string, unknown>;
  };
  threadId: string | null;
  protocolLabel: string;
  description: string;
  eventLog: TraceEntry[];
  onSubmit: (content: string) => void;
}) {
  const metadata = useMemo(
    () => getLastAssistantMetadata(stream.messages, stream.getMessagesMetadata),
    [stream.messages, stream.getMessagesMetadata]
  );

  const subagentDebug = useMemo(() => {
    const entries = Array.from(
      stream.subagents.entries() as Iterable<[string, unknown]>
    );

    return entries
      .map(([id, subagent]) => {
        const state = subagent as {
          status?: string;
          result?: unknown;
          error?: unknown;
          messages?: BaseMessage[];
          namespace?: string[];
          values?: Record<string, unknown>;
          toolCall?: {
            name?: string;
            args?: Record<string, unknown>;
          };
        };
        const liveMessages = state.messages ?? [];
        const snapshotMessages = Array.isArray(state.values?.messages)
          ? ensureBaseMessages(state.values.messages)
          : [];
        const displayMessages =
          snapshotMessages.length > liveMessages.length
            ? snapshotMessages
            : liveMessages;
        const displayPreview = getSubagentPreview(displayMessages);
        return {
          id,
          status: getDisplaySubagentStatus({
            status: state.status,
            result: state.result,
            error: state.error,
          }),
          namespace: state.namespace ?? [],
          toolName: state.toolCall?.name,
          toolArgs: state.toolCall?.args,
          messageCount: displayMessages.length,
          snapshotMessageCount: snapshotMessages.length,
          preview: displayPreview,
          liveMessages: summarizeDebugMessages(liveMessages),
          snapshotMessages: summarizeDebugMessages(snapshotMessages),
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
  }, [subagentDebug]);

  return (
    <ProtocolPlayground
      apiUrl={API_URL}
      assistantId="deep-agent"
      description={description}
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={onSubmit}
      placeholder="Pick a topic and ask for a haiku, limerick, quatrain, and fifty-line poem so the coordinator fans work out to four subagents."
      protocolLabel={protocolLabel}
      subagents={subagents}
      suggestions={[
        "Write a haiku, limerick, quatrain, and fifty-line poem about spring rain in the city.",
        "Create a haiku, limerick, quatrain, and fifty-line poem about debugging late at night.",
      ]}
      threadId={threadId}
      title="Deep Agent Runtime"
      values={stream.values}
    />
  );
}
