<script lang="ts">
  import { useStream } from "../../index.js";

  interface Props {
    apiUrl: string;
  }

  const { apiUrl }: Props = $props();

  const { interrupts, isLoading, submit } = useStream({
    assistantId: "interruptAgent",
    apiUrl,
    fetchStateHistory: false,
  });
</script>

<div>
  <div data-testid="interrupts-count">{$interrupts.length}</div>
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
