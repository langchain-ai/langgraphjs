<script lang="ts">
  import { useStream } from "../../index.js";

  interface InterruptState {
    request: string;
    decision: Record<string, unknown> | null;
    completedTurns: number;
  }

  interface Props {
    apiUrl: string;
    threadId?: string;
    onThreadId: (threadId: string) => void;
    fetch: typeof globalThis.fetch;
  }

  const { apiUrl, threadId, onThreadId, fetch }: Props = $props();
  const stream = useStream<InterruptState>({
    assistantId: "interrupt_once_graph",
    apiUrl,
    threadId,
    onThreadId,
    fetch,
  });
</script>

<div data-testid="interrupt-count">{stream.interrupts.length}</div>
<div data-testid="interrupt-ids">
  {stream.interrupts.map((item) => item.id ?? "?").join(",")}
</div>
<div data-testid="completed-turns">
  {stream.values?.completedTurns ?? 0}
</div>
<div data-testid="loading">
  {stream.isLoading ? "Loading..." : "Not loading"}
</div>
<div data-testid="thread-loading">
  {stream.isThreadLoading ? "Hydrating..." : "Ready"}
</div>
<button
  data-testid="submit"
  onclick={() => void stream.submit({ request: "ship it" })}
>
  Submit
</button>
<button
  data-testid="resume"
  onclick={() => {
    if (stream.interrupt) {
      void stream.respond({ approved: true });
    }
  }}
>
  Resume
</button>
