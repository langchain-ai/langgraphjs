import { useStream } from "../../index.js";

interface NestedInterruptState {
  request?: string;
  decision?: Record<string, unknown> | null;
  completed?: boolean;
  messages?: unknown[];
}

interface Props {
  apiUrl: string;
  assistantId: string;
  threadId?: string;
  onThreadId?: (threadId: string) => void;
  /** Payload passed to `submit()` — graph-specific. */
  submitInput: Record<string, unknown>;
}

/**
 * HITL harness for nested / subagent interrupts.
 *
 * Exposes namespace and resumes via `respond({ interruptId })` without
 * an explicit `namespace` so the controller lookup path is covered.
 */
export function NestedInterruptStream({
  apiUrl,
  assistantId,
  threadId,
  onThreadId,
  submitInput,
}: Props) {
  const thread = useStream<NestedInterruptState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });

  const promptValue = thread.interrupt?.value;
  const interruptPrompt =
    promptValue != null &&
    typeof promptValue === "object" &&
    "prompt" in (promptValue as object)
      ? String((promptValue as { prompt?: unknown }).prompt ?? "")
      : "";

  const namespace = thread.interrupt?.namespace ?? [];

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-prompt">{interruptPrompt}</div>
      <div data-testid="interrupt-id">{thread.interrupt?.id ?? ""}</div>
      <div data-testid="interrupt-namespace">{JSON.stringify(namespace)}</div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit(submitInput)}
      >
        Submit
      </button>
      <button
        data-testid="resume"
        onClick={() => {
          const id = thread.interrupt?.id;
          if (id != null) {
            void thread.respond({ approved: true }, { interruptId: id });
          }
        }}
      >
        Resume
      </button>
    </div>
  );
}
