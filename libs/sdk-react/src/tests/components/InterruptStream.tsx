import { useStream } from "../../index.js";

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completed: boolean;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  threadId?: string;
  onThreadId?: (threadId: string) => void;
}

export function InterruptStream({
  apiUrl,
  assistantId = "interrupt_graph",
  threadId,
  onThreadId,
}: Props) {
  const thread = useStream<InterruptState>({
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

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="interrupt-prompt">{interruptPrompt}</div>
      <div data-testid="interrupt-id">
        {thread.interrupt?.id ?? ""}
      </div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <div data-testid="decision">
        {thread.values?.decision
          ? JSON.stringify(thread.values.decision)
          : "null"}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
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
