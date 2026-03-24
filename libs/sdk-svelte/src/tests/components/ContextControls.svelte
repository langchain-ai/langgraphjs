<script lang="ts">
  import { getStream } from "../../index.js";

  const stream = getStream();
</script>

<div>
  <div data-testid="loading">
    {stream.isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if stream.error}
    <div data-testid="error">{String(stream.error)}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() => void stream.submit({ messages: [{ content: "Hello", type: "human" }] })}
  >
    Send
  </button>
  <button data-testid="stop" onclick={() => void stream.stop()}>Stop</button>
</div>
