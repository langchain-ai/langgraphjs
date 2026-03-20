<script lang="ts">
  import { getStreamContext } from "../../index.js";

  const { messages, isLoading, error } = getStreamContext();
</script>

<div data-testid="child-container">
  <div data-testid="child-loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if $error}
    <div data-testid="child-error">{String($error)}</div>
  {/if}
  <div data-testid="child-message-count">{$messages.length}</div>
  {#each $messages as msg, i (msg.id ?? i)}
    <div data-testid={`child-message-${i}`}>
      {typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content)}
    </div>
  {/each}
</div>
