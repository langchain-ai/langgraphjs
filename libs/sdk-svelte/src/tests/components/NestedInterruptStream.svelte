<script lang="ts">
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
    submitInput: Record<string, unknown>;
  }

  const {
    apiUrl,
    assistantId,
    threadId,
    onThreadId,
    submitInput,
  }: Props = $props();

  const stream = useStream<NestedInterruptState>({
    assistantId,
    apiUrl,
    threadId,
    onThreadId,
  });

  const interruptPrompt = $derived.by(() => {
    const promptValue = stream.interrupt?.value;
    if (
      promptValue != null &&
      typeof promptValue === "object" &&
      "prompt" in (promptValue as object)
    ) {
      return String((promptValue as { prompt?: unknown }).prompt ?? "");
    }
    return "";
  });

  const namespaceJson = $derived(
    JSON.stringify(stream.interrupt?.namespace ?? []),
  );
</script>

<div>
  <div data-testid="interrupt-count">{stream.interrupts.length}</div>
  <div data-testid="interrupt-prompt">{interruptPrompt}</div>
  <div data-testid="interrupt-id">{stream.interrupt?.id ?? ""}</div>
  <div data-testid="interrupt-namespace">{namespaceJson}</div>
  <div data-testid="completed">
    {stream.values?.completed ? "true" : "false"}
  </div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() => void stream.submit(submitInput)}
  >
    Submit
  </button>
  <button
    data-testid="resume"
    onclick={() => {
      const id = stream.interrupt?.id;
      if (id != null) {
        void stream.respond({ approved: true }, { interruptId: id });
      }
    }}
  >
    Resume
  </button>
</div>
