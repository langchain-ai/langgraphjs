import { useCallback, useMemo, useState } from "react";

import { useStream } from "@langchain/react";

import type { agent as stategraphAgentType } from "../agents/basic-stategraph";
import type { PlaygroundTransportMode } from "../components/ProtocolSwitcher";
import { ProtocolPlayground } from "../components/ProtocolPlayground";
import { getLastAssistantMetadata } from "../utils";
import {
  API_URL,
  getTransportLabel,
  getStreamProtocol,
  isProtocolTransportMode,
  summarizeToolEvent,
  summarizeUpdateEvent,
  useTraceLog,
} from "./shared";

export function StateGraphView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolStateGraphView transportMode={transportMode} />
  ) : (
    <LegacyStateGraphView />
  );
}

function LegacyStateGraphView() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const stream = useStream<typeof stategraphAgentType>({
    assistantId: "stategraph",
    apiUrl: API_URL,
    streamProtocol: "legacy",
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
      description="This view uses the standard useStream setup from the existing React examples, backed by the legacy streaming API."
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder="Ask the graph to explain a protocol feature or sketch a test checklist."
      protocolLabel={getTransportLabel("legacy")}
      suggestions={[
        "Explain how the current streaming path differs from the new session protocol.",
        "Create a quick checklist for validating message and tool streaming.",
      ]}
      threadId={threadId}
      title="Basic StateGraph"
      values={stream.values}
    />
  );
}

function ProtocolStateGraphView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();

  const stream = useStream<typeof stategraphAgentType>({
    assistantId: "stategraph",
    apiUrl: API_URL,
    streamProtocol: getStreamProtocol(transportMode),
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
      description="This view drives a compiled StateGraph through the new session-based protocol transport."
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
