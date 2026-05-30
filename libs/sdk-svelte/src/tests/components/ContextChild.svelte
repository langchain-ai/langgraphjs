<script lang="ts">
  import { getStream } from "../../index.js";

  const stream = getStream();
</script>

<div data-testid="child">
  <div data-testid="child-loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  <div data-testid="child-message-count">{stream.messages.length}</div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div data-testid={`child-message-${i}`}>
      {typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content)}
    </div>
  {/each}
</div>
