<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const { toolCalls, isLoading, submit } = useStream({
    assistantId: "agent",
    apiUrl,
  });
</script>

<div>
  <div data-testid="tool-calls-count">{$toolCalls.length}</div>
  <div data-testid="loading">
    {$isLoading ? "Loading" : "Not loading"}
  </div>
  <button
    data-testid="submit"
    onclick={() =>
      void submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>
</div>
