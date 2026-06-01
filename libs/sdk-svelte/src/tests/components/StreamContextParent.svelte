<script lang="ts">
  import { provideStream } from "../../index.js";
  import StreamContextChild from "./StreamContextChild.svelte";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  // svelte-ignore state_referenced_locally
  const stream = provideStream({
    assistantId,
    apiUrl,
  });
</script>

<div data-testid="parent-container">
  <div data-testid="parent-loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="parent-message-count">{stream.messages.length}</div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div data-testid={`parent-message-${i}`}>
      {typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content)}
    </div>
  {/each}
  <button
    data-testid="parent-submit"
    onclick={() =>
      void stream.submit({ messages: [{ content: "Hello", type: "human" }] } as any)}
  >
    Send
  </button>

  <StreamContextChild />
</div>
