import { useEffect, useState } from "react";

import { useStream } from "../../index.js";

interface MultiInterruptState {
  prompts: string[];
  decisions: Record<string, unknown>;
  completed: boolean;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
}

/** Milliseconds the session stays unmounted during a reload. */
const RELOAD_GAP_MS = 100;

/**
 * Parallel-interrupt harness whose `reload` button remounts `useStream` on
 * the same thread, like a page refresh, so a test can check what the server
 * kept rather than what the client still shows.
 */
export function MultiInterruptReloadStream({
  apiUrl,
  assistantId = "multi_interrupt_graph",
}: Props) {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [session, setSession] = useState(0);
  const [mounted, setMounted] = useState(true);

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
      <button data-testid="reload" onClick={() => setMounted(false)}>
        Reload
      </button>
      {mounted ? (
        <Session
          key={session}
          apiUrl={apiUrl}
          assistantId={assistantId}
          threadId={threadId}
          onThreadId={setThreadId}
        />
      ) : null}
    </div>
  );
}

interface SessionProps {
  apiUrl: string;
  assistantId: string;
  threadId: string | null;
  onThreadId: (threadId: string) => void;
}

function Session({ apiUrl, assistantId, threadId, onThreadId }: SessionProps) {
  const thread = useStream<MultiInterruptState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });
  const [actionError, setActionError] = useState("");
  const record = (error: unknown) =>
    setActionError(error instanceof Error ? error.message : String(error));

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="thread-loading">
        {thread.isThreadLoading ? "Hydrating..." : "Ready"}
      </div>
      <div data-testid="error">{thread.error ? String(thread.error) : ""}</div>
      <div data-testid="action-error">{actionError}</div>
      <button
        data-testid="submit"
        onClick={() => {
          setActionError("");
          void thread.submit({ prompts: ["A", "B"] }).catch(record);
        }}
      >
        Submit
      </button>
      <button
        data-testid="free-text-submit"
        onClick={() => {
          setActionError("");
          void thread.submit({ prompts: ["follow-up"] }).catch(record);
        }}
      >
        Free-text submit
      </button>
      <button
        data-testid="resume-all"
        onClick={() => {
          setActionError("");
          void thread
            .respondAll(
              Object.fromEntries(
                thread.interrupts.flatMap((entry) =>
                  entry.id == null ? [] : [[entry.id, { approved: true }]]
                )
              )
            )
            .catch(record);
        }}
      >
        Resume all
      </button>
    </div>
  );
}
