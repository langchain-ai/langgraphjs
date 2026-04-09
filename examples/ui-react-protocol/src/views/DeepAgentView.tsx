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
  getLastAssistantMetadata,
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
      description="This view exercises a Deep Agent with three subagents so you can inspect hierarchical streaming over the new protocol."
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

    return entries.map(([id, subagent]) => {
      const state = subagent as {
        status?: string;
        messages?: BaseMessage[];
        namespace?: string[];
        values?: Record<string, unknown>;
        toolCall?: {
          name?: string;
          args?: Record<string, unknown>;
        };
      };
      const snapshotMessages = Array.isArray(state.values?.messages)
        ? ensureBaseMessages(state.values.messages)
        : [];
      const livePreview = getSubagentPreview(state.messages);
      const snapshotPreview = getSubagentPreview(snapshotMessages);
      return {
        id,
        status: state.status ?? "unknown",
        namespace: state.namespace ?? [],
        toolName: state.toolCall?.name,
        toolArgs: state.toolCall?.args,
        messageCount: state.messages?.length ?? 0,
        snapshotMessageCount: snapshotMessages.length,
        preview: livePreview ?? snapshotPreview,
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
      placeholder="Ask for a research, planning, and risk-review pass so the coordinator fans work out to subagents."
      protocolLabel={protocolLabel}
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
