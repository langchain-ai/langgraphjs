<script lang="ts">
  import { getStream } from "../../index.js";

  const stream = getStream();
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
