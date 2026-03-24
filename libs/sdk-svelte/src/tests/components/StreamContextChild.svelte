<script lang="ts">
  import { getStreamContext } from "../../index.js";

  const stream = getStreamContext();
</script>

<div data-testid="child-container">
  <div data-testid="child-loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.error}
    <div data-testid="child-error">{String(stream.error)}</div>
  {/if}
  <div data-testid="child-message-count">{stream.messages.length}</div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div data-testid={`child-message-${i}`}>
      {typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content)}
    </div>
  {/each}
</div>
