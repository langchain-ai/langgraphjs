<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const stream = useStream({
    assistantId: "agent",
    apiUrl,
  });
</script>

<div>
  <div data-testid="tool-calls-count">{stream.toolCalls.length}</div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading" : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void stream.submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
