import { useEffect, useMemo, useState } from "react";

import { useStream } from "../../index.js";
import { createDroppableAuthFetch } from "../fixtures/droppable-auth-fetch.js";

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completed: boolean;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/**
 * Interrupt + respond harness that routes every request through a custom
 * auth-style `fetch` and can force-drop active SSE streams mid-HITL.
 */
export function InterruptReconnectStream({
  apiUrl,
  assistantId = "interrupt_graph",
}: Props) {
  const droppable = useMemo(() => createDroppableAuthFetch(), []);
  const [reconnectCount, setReconnectCount] = useState(0);
  const [eventOpens, setEventOpens] = useState(0);

  // Keep open-count / reconnect telemetry painted while reconnect races run.
  useEffect(() => {
    const id = window.setInterval(() => {
      setEventOpens(droppable.eventStreamOpenCount());
    }, 50);
    return () => window.clearInterval(id);
  }, [droppable]);

  const thread = useStream<InterruptState>({
    assistantId,
    apiUrl,
    fetch: droppable.fetch,
    maxReconnectAttempts: 5,
    reconnectDelayMs: () => 0,
    streamIdleReconnect: 0,
    onReconnect: () => {
      setReconnectCount((count) => count + 1);
      setEventOpens(droppable.eventStreamOpenCount());
    },
  });

  const promptValue = thread.interrupt?.value;
  const interruptPrompt =
    promptValue != null &&
    typeof promptValue === "object" &&
    "prompt" in (promptValue as object)
      ? String((promptValue as { prompt?: unknown }).prompt ?? "")
      : "";

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-prompt">{interruptPrompt}</div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="reconnect-count">{reconnectCount}</div>
      <div data-testid="event-stream-opens">{eventOpens}</div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit({ request: "ship it" })}
      >
        Submit
      </button>
      <button
        data-testid="drop-events"
        onClick={() => {
          droppable.dropActiveStreams();
          setEventOpens(droppable.eventStreamOpenCount());
        }}
      >
        Drop events
      </button>
      <button
        data-testid="resume"
        onClick={() => {
          if (thread.interrupt) {
            void thread.respond({ approved: true });
          }
        }}
      >
        Resume
      </button>
    </div>
  );
}
