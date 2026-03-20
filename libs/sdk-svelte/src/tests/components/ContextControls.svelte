<script lang="ts">
  import { getStream } from "../../index.js";

  const { submit, stop, isLoading, error } = getStream();
</script>

<div>
  <div data-testid="loading">
    {$isLoading ? "Loading..." : "Not loading"}
  </div>
  {#if $error}
    <div data-testid="error">{String($error)}</div>
  {/if}
  <button
    data-testid="submit"
    onclick={() => void submit({ messages: [{ content: "Hello", type: "human" }] })}
  >
    Send
  </button>
  <button data-testid="stop" onclick={() => void stop()}>Stop</button>
</div>
