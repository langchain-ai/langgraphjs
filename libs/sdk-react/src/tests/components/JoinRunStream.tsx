import { useEffect, useRef, useState } from "react";
import type { Client, Message } from "@langchain/langgraph-sdk";
import { useStream } from "../../index.js";

interface Props {
  apiUrl: string;
  client: Client;
  threadId: string;
  runId?: string;
  reconnectOnMount?: boolean;
}

export function JoinRunStream({
  apiUrl,
  client,
  threadId,
  runId,
  reconnectOnMount,
}: Props) {
  const [createdRunId, setCreatedRunId] = useState<string>();
  const [loadingStarts, setLoadingStarts] = useState(0);

  const stream = useStream<{ messages: Message[] }>({
    assistantId: "agent",
    apiUrl,
    client,
    threadId,
    reconnectOnMount,
    fetchStateHistory: false,
    onCreated: (run) => setCreatedRunId(run.run_id),
  });

  const wasLoadingRef = useRef(false);
  useEffect(() => {
    if (stream.isLoading && !wasLoadingRef.current) {
      setLoadingStarts((count) => count + 1);
    }
    wasLoadingRef.current = stream.isLoading;
  }, [stream.isLoading]);

  const joinRunId = runId ?? createdRunId;

  return (
    <div>
      <div data-testid="loading">
        {stream.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="loading-starts">{loadingStarts}</div>
      <div data-testid="created-run-id">{createdRunId ?? ""}</div>
      <div data-testid="message-count">{stream.messages.length}</div>
      <button
        data-testid="submit"
        onClick={() =>
          void stream.submit({
            messages: [{ content: "Hi", type: "human" }],
          })
        }
      >
        Submit
      </button>
      <button
        data-testid="join"
        onClick={() => {
          if (joinRunId) void stream.joinStream(joinRunId);
        }}
      >
        Join
      </button>
    </div>
  );
}
