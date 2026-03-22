<script lang="ts">
  import { getStreamContext } from "../../index.js";

  const stream = getStreamContext();
</script>

<div data-testid="messages">
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div data-testid={`message-${i}`}>
      {typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content)}
    </div>
  {/each}
</div>
