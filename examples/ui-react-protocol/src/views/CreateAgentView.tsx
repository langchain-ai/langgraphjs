import { useCallback, useMemo, useState } from "react";

import { useStream } from "@langchain/react";

import type { agent as createAgentType } from "../agents/create-agent";
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

export function CreateAgentView({
  transportMode,
}: {
  transportMode: PlaygroundTransportMode;
}) {
  return isProtocolTransportMode(transportMode) ? (
    <ProtocolCreateAgentView transportMode={transportMode} />
  ) : (
    <LegacyCreateAgentView />
  );
}

function LegacyCreateAgentView() {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();
  const stream = useStream<typeof createAgentType>({
    assistantId: "create-agent",
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
      assistantId="create-agent"
      description="This view uses createAgent with the same legacy streaming path the standard React examples use today."
      eventLog={eventLog}
      getMessageMetadata={(message) =>
        stream.getMessagesMetadata?.(message as never)
      }
      isLoading={stream.isLoading}
      messages={stream.messages}
      metadata={metadata}
      onSubmit={handleSubmit}
      placeholder="Ask the agent to compare protocol features, build a plan, or review risks."
      protocolLabel={getTransportLabel("legacy")}
      suggestions={[
        "Compare the legacy stream to the new protocol from a frontend perspective.",
        "Review likely rough edges when migrating a React client away from legacy streaming.",
      ]}
      threadId={threadId}
      title="createAgent Runtime"
      values={stream.values}
    />
  );
}

function ProtocolCreateAgentView({
  transportMode,
}: {
  transportMode: Exclude<PlaygroundTransportMode, "legacy">;
}) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const { eventLog, push } = useTraceLog();

  const stream = useStream<typeof createAgentType>({
    assistantId: "create-agent",
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
      assistantId="create-agent"
      description="This view uses createAgent while the client opts into the new session-based protocol transport."
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
