import { useStream } from "../../index.js";

interface InterruptState {
  request: string;
  decision: Record<string, unknown> | null;
  completed: boolean;
}

interface Props {
  apiUrl: string;
  assistantId?: string;
  /** When true, the Resume button uses stream.respond() directly. */
  useRespondMethod?: boolean;
}

export function InterruptStream({
  apiUrl,
  assistantId = "interrupt_graph",
  useRespondMethod = false,
}: Props) {
  const thread = useStream<InterruptState>({
    assistantId,
    apiUrl,
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
          if (useRespondMethod && thread.interrupt) {
            void thread.respond({ approved: true });
          } else {
            void thread.submit(undefined, {
              command: { resume: { approved: true } },
            });
          }
        }}
      >
        Resume
      </button>
    </div>
  );
}
