<script lang="ts">
  import { useStream } from "../../index.js";

  interface MultiInterruptState {
    prompts: string[];
    decisions: Record<string, unknown>;
    completed: boolean;
  }

  interface Props {
    apiUrl: string;
    assistantId: string;
    threadId: string | null;
    onThreadId: (threadId: string) => void;
  }

  const { apiUrl, assistantId, threadId, onThreadId }: Props = $props();

  // svelte-ignore state_referenced_locally
  const thread = useStream<MultiInterruptState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });

  let actionError = $state("");
  const record = (error: unknown) => {
    actionError = error instanceof Error ? error.message : String(error);
  };
</script>

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
    onclick={() => {
      actionError = "";
      void thread.submit({ prompts: ["A", "B"] }).catch(record);
    }}
  >
    Submit
  </button>
  <button
    data-testid="free-text-submit"
    onclick={() => {
      actionError = "";
      void thread.submit({ prompts: ["follow-up"] }).catch(record);
    }}
  >
    Free-text submit
  </button>
  <button
    data-testid="resume-all"
    onclick={() => {
      actionError = "";
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
