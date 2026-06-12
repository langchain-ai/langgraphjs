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

export function MultiInterruptStream({
  apiUrl,
  assistantId = "multi_interrupt_graph",
}: Props) {
  const thread = useStream<MultiInterruptState>({
    assistantId,
    apiUrl,
  });

  const pendingInterrupts = thread.getThread()?.interrupts ?? [];

  return (
    <div>
      <div data-testid="interrupt-count">{thread.interrupts.length}</div>
      <div data-testid="thread-interrupt-count">
        {pendingInterrupts.length}
      </div>
      <div data-testid="completed">
        {thread.values?.completed ? "true" : "false"}
      </div>
      <div data-testid="decisions">
        {thread.values?.decisions
          ? JSON.stringify(thread.values.decisions)
          : "{}"}
      </div>
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <button
        data-testid="submit"
        onClick={() => void thread.submit({ prompts: ["A", "B"] })}
      >
        Submit
      </button>
      <button
        data-testid="resume-all"
        onClick={() => {
          const interrupts = thread.getThread()?.interrupts ?? [];
          if (interrupts.length === 0) return;
          void thread.respondAll(
            Object.fromEntries(
              interrupts.map((entry) => {
                const action =
                  entry.payload != null &&
                  typeof entry.payload === "object" &&
                  "action" in entry.payload
                    ? String((entry.payload as { action?: unknown }).action)
                    : "";
                return [
                  entry.interruptId,
                  action === "A"
                    ? { approved: true }
                    : { approved: false },
                ];
              })
            )
          );
        }}
      >
        Resume all
      </button>
    </div>
  );
}
