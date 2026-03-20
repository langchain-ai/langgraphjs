<script lang="ts">
  import { useStream, setStreamContext } from "../../index.js";
  import StreamContextChild from "./StreamContextChild.svelte";

  interface Props {
    apiUrl: string;
    assistantId?: string;
  }

  const { apiUrl, assistantId = "agent" }: Props = $props();

  const stream = useStream({
    assistantId,
    apiUrl,
  });

  setStreamContext(stream);
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
