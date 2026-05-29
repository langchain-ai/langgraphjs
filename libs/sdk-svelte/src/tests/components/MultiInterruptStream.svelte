<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "multi_interrupt_graph" }: Props = $props();

  const stream = useStream<{
    prompts: string[];
    decisions: Record<string, unknown>;
    completed: boolean;
  }>({
    assistantId,
    apiUrl,
  });

  const pendingInterruptCount = $derived.by(() => {
    const loading = stream.isLoading;
    const rootInterruptCount = stream.interrupts.length;
    const values = stream.values;
    if (loading || rootInterruptCount >= 0 || values != null) {
      return stream.getThread()?.interrupts.length ?? 0;
    }
    return 0;
  });

  const decisionsJson = $derived(
    JSON.stringify(stream.values?.decisions ?? {})
  );
</script>

<div>
  <div data-testid="interrupt-count">{stream.interrupts.length}</div>
  <div data-testid="thread-interrupt-count">{pendingInterruptCount}</div>
  <div data-testid="completed">{stream.values?.completed ? "true" : "false"}</div>
  <div data-testid="decisions">{decisionsJson}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() => void stream.submit({ prompts: ["A", "B"] })}
  >
    Submit
  </button>
  <button
    data-testid="resume-all"
    onclick={() => {
      const interrupts = stream.getThread()?.interrupts ?? [];
      if (interrupts.length === 0) return;
      void stream.respondAll(
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
              action === "A" ? { approved: true } : { approved: false },
            ];
          })
        )
      );
    }}
  >
    Resume all
  </button>
</div>
