import { useEffect, useMemo, useState } from "react";

import { useStream } from "../../index.js";
import { createDurableReplayFetch } from "../fixtures/durable-replay-fetch.js";

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completedTurns: number;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

interface SessionProps extends Props {
  threadId: string | null;
  onThreadId: (threadId: string) => void;
  fetch: typeof fetch;
}

/** Milliseconds the hook stays unmounted while a reload is simulated. */
const RELOAD_GAP_MS = 100;

function InterruptSession({
  apiUrl,
  assistantId = "interrupt_once_graph",
  threadId,
  onThreadId,
  fetch: fetchImpl,
}: SessionProps) {
  const thread = useStream<InterruptState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
    fetch: fetchImpl,
  });

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-ids">
        {thread.interrupts.map((item) => item.id ?? "?").join(",")}
      </div>
      <div data-testid="completed-turns">
        {thread.values?.completedTurns ?? 0}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-loading">
        {thread.isThreadLoading ? "Hydrating..." : "Ready"}
      </div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit({ request: "ship it" })}
      >
        Submit
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

/**
 * HITL harness that can drop and rebuild its `useStream` session while
 * keeping the same `threadId`, the way a browser reload does. The
 * remounted hook re-hydrates from persisted server state and has no
 * memory of interrupts the previous session resolved.
 *
 * Event history outlives the reload, as it does on LangGraph Platform, so
 * the reconnecting session replays the interrupt the previous one resolved.
 */
export function InterruptReloadStream({ apiUrl, assistantId }: Props) {
  const durable = useMemo(() => createDurableReplayFetch(), []);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [replayedFrames, setReplayedFrames] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setReplayedFrames(durable.replayedFrameCount());
    }, 50);
    return () => window.clearInterval(id);
  }, [durable]);

  useEffect(() => {
    if (mounted) return undefined;
    const timer = window.setTimeout(() => {
      setSession((current) => current + 1);
      setMounted(true);
    }, RELOAD_GAP_MS);
    return () => window.clearTimeout(timer);
  }, [mounted]);

  return (
    <div>
      <div data-testid="session">{session}</div>
      <div data-testid="thread-id">{threadId ?? "none"}</div>
      <div data-testid="replayed-frames">{replayedFrames}</div>
      <button data-testid="reload" onClick={() => setMounted(false)}>
        Reload
      </button>
      {mounted ? (
        <InterruptSession
          key={session}
          apiUrl={apiUrl}
          assistantId={assistantId}
          threadId={threadId}
          onThreadId={setThreadId}
          fetch={durable.fetch}
        />
      ) : null}
    </div>
  );
}
