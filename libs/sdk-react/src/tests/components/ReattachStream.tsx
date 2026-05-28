import { useState } from "react";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { useStream } from "../../index.js";

interface StreamState {
  messages: BaseMessage[];
}

interface Props {
  apiUrl?: string;
  assistantId?: string;
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
}: Props) {
  const [threadId, setThreadId] = useState<string | undefined>(undefined);
  const [secondaryMounted, setSecondaryMounted] = useState(false);

  const primary = useStream<StreamState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId: (id) => setThreadId(id),
  });

  return (
    <div>
      <div data-testid="primary-loading">
        {primary.isLoading ? "Loading..." : "Not loading"}
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
      {secondaryMounted && threadId != null ? (
        <SecondaryStream apiUrl={apiUrl} assistantId={assistantId} threadId={threadId} />
      ) : (
        <div data-testid="secondary-mounted">no</div>
      )}
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
