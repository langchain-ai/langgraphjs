import { useRef, useState } from "react";
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

/**
 * Resume parallel interrupts one-at-a-time, then finish with respondAll.
 * Guards the stale-empty `stream.interrupts` regression: after a partial
 * sequential resume the UI must not look "done" while siblings remain.
 */
export function MultiInterruptSequentialStream({
  apiUrl,
  assistantId = "multi_interrupt_graph",
}: Props) {
  const thread = useStream<MultiInterruptState>({
    assistantId,
    apiUrl,
  });
  const [submitError, setSubmitError] = useState("");
  const [resumeError, setResumeError] = useState("");
  const [interruptsAtSubmit, setInterruptsAtSubmit] = useState<number | null>(
    null
  );
  const resumingRef = useRef(false);

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
      <div data-testid="loading">
        {thread.isLoading ? "Loading..." : "Not loading"}
      </div>
      <div data-testid="submit-error">{submitError}</div>
      <div data-testid="resume-error">{resumeError}</div>
      <div data-testid="interrupts-at-submit">
        {interruptsAtSubmit == null ? "" : String(interruptsAtSubmit)}
      </div>
      <button
        data-testid="submit"
        onClick={() => {
          setSubmitError("");
          void thread
            .submit({ prompts: ["A", "B"] })
            .catch((error: unknown) => {
              setSubmitError(
                error instanceof Error ? error.message : String(error)
              );
            });
        }}
      >
        Submit
      </button>
      <button
        data-testid="resume-next"
        onClick={() => {
          if (resumingRef.current) return;
          const next = thread.interrupts[0];
          if (next?.id == null) return;
          resumingRef.current = true;
          setResumeError("");
          const action =
            next.value != null &&
            typeof next.value === "object" &&
            "action" in next.value
              ? String((next.value as { action?: unknown }).action ?? "")
              : "";
          void thread
            .respond(
              action === "A" ? { approved: true } : { approved: false },
              { interruptId: next.id }
            )
            .catch((error: unknown) => {
              setResumeError(
                error instanceof Error ? error.message : String(error)
              );
            })
            .finally(() => {
              resumingRef.current = false;
            });
        }}
      >
        Resume next
      </button>
      <button
        data-testid="resume-all"
        onClick={() => {
          const interrupts = thread.getThread()?.interrupts ?? [];
          if (interrupts.length === 0) return;
          setResumeError("");
          void thread
            .respondAll(
              Object.fromEntries(
                interrupts.map((entry) => {
                  const action =
                    entry.payload != null &&
                    typeof entry.payload === "object" &&
                    "action" in entry.payload
                      ? String(
                          (entry.payload as { action?: unknown }).action ?? ""
                        )
                      : "";
                  return [
                    entry.interruptId,
                    action === "A"
                      ? { approved: true }
                      : { approved: false },
                  ];
                })
              )
            )
            .catch((error: unknown) => {
              setResumeError(
                error instanceof Error ? error.message : String(error)
              );
            });
        }}
      >
        Resume all
      </button>
      <button
        data-testid="follow-up-submit"
        onClick={() => {
          setInterruptsAtSubmit(thread.interrupts.length);
          setSubmitError("");
          void thread
            .submit({ prompts: ["follow-up"] })
            .catch((error: unknown) => {
              setSubmitError(
                error instanceof Error ? error.message : String(error)
              );
            });
        }}
      >
        Follow-up submit
      </button>
    </div>
  );
}
