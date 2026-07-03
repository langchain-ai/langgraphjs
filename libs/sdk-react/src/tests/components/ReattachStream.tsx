import { useMemo, useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { Client } from "@langchain/langgraph-sdk";
import type { AgentServerAdapter } from "@langchain/langgraph-sdk/stream";

import { useStream, type UseStreamOptions } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

interface Props {
  apiUrl?: string;
  assistantId?: string;
  createSecondaryTransport?: (threadId: string) => AgentServerAdapter;
  createSecondaryClient?: (threadId: string) => Client;
}

/**
 * Harness for the `R2.7` re-attach acceptance test. Layout:
 *
 *   1. Primary hook (`primary-*`) starts a slow run on a known thread.
 *   2. A second hook (`secondary-*`) is toggled on *after* the run
 *      has begun server-side but *before* it terminates — the
 *      secondary hook receives the same `threadId` via props, so its
 *      `hydrate()` should attach to the in-flight run and transition
 *      `isLoading` to `true` without issuing a new submit.
 */
export function ReattachStream({
  apiUrl,
  assistantId = "slow_graph",
  createSecondaryTransport,
  createSecondaryClient,
}: Props) {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [secondaryMounted, setSecondaryMounted] = useState(false);
  const [primaryRunCreated, setPrimaryRunCreated] = useState(false);
  const secondaryTransport = useMemo(
    () => (threadId != null ? createSecondaryTransport?.(threadId) : undefined),
    [createSecondaryTransport, threadId],
  );
  const secondaryClient = useMemo(
    () => (threadId != null ? createSecondaryClient?.(threadId) : undefined),
    [createSecondaryClient, threadId],
  );

  const primary = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId: (id) => setThreadId(id),
    onCreated: () => setPrimaryRunCreated(true),
  });
  let secondaryContent = <div data-testid="secondary-mounted">no</div>;
  if (secondaryMounted && threadId != null) {
    secondaryContent =
      secondaryTransport != null ? (
        <SecondaryCustomStream
          client={secondaryClient}
          transport={secondaryTransport}
          threadId={threadId}
        />
      ) : (
        <SecondaryStream
          apiUrl={apiUrl}
          assistantId={assistantId}
          threadId={threadId}
        />
      );
  }

  return (
    <div>
      <div data-testid="primary-loading">
        {primary.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="primary-run-created">
        {primaryRunCreated ? "yes" : "no"}
      </div>
      <div data-testid="primary-thread-id">{primary.threadId ?? "none"}</div>
      <div data-testid="primary-message-count">{primary.messages.length}</div>
      <button
        data-testid="primary-submit"
        onClick={() =>
          void primary.submit({ messages: [new HumanMessage("Hello")] })
        }
      >
        Start slow run
      </button>
      <button
        data-testid="secondary-mount"
        disabled={threadId == null}
        onClick={() => setSecondaryMounted(true)}
      >
        Mount secondary
      </button>
      <button
        data-testid="secondary-unmount"
        onClick={() => setSecondaryMounted(false)}
      >
        Unmount secondary
      </button>
      {secondaryContent}
    </div>
  );
}

interface SecondaryProps {
  apiUrl?: string;
  assistantId: string;
  threadId: string;
}

function SecondaryStream({ apiUrl, assistantId, threadId }: SecondaryProps) {
  const secondary = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
  });
  return (
    <div>
      <div data-testid="secondary-mounted">yes</div>
      <div data-testid="secondary-loading">
        {secondary.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="secondary-thread-id">
        {secondary.threadId ?? "none"}
      </div>
      <div data-testid="secondary-message-count">
        {secondary.messages.length}
      </div>
    </div>
  );
}

interface SecondaryCustomProps {
  client?: Client;
  transport: AgentServerAdapter;
  threadId: string;
}

function SecondaryCustomStream({
  client,
  transport,
  threadId,
}: SecondaryCustomProps) {
  const options = {
    ...(client != null ? { client } : {}),
    transport,
    threadId,
  } as unknown as UseStreamOptions<StreamState>;
  const secondary = useStream<StreamState>(options);
  return (
    <div>
      <div data-testid="secondary-mounted">yes</div>
      <div data-testid="secondary-loading">
        {secondary.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="secondary-thread-id">
        {secondary.threadId ?? "none"}
      </div>
      <div data-testid="secondary-message-count">
        {secondary.messages.length}
      </div>
    </div>
  );
}
