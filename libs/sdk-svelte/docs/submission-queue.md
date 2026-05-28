## Submission queue

When `submit()` is called while a run is already in flight, pass `multitaskStrategy: "enqueue"` to queue it on the server. The `useSubmissionQueue` composable exposes a reactive view of pending entries, plus helpers to cancel individual entries or clear the queue entirely.

```svelte
<script lang="ts">
  import { useStream, useSubmissionQueue } from "@langchain/svelte";

  const stream = useStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });
  const queue = useSubmissionQueue(stream);

  function queueTurn() {
    stream.submit(
      { messages: [{ type: "human", content: "go" }] },
      { multitaskStrategy: "enqueue" },
    );
  }
</script>

<button onclick={queueTurn}>Queue turn</button>

{#if queue.size > 0}
  <p>{queue.size} run(s) pending</p>
  <ol>
    {#each queue.entries as entry (entry.id)}
      <li>
        pending…
        <button onclick={() => queue.cancel(entry.id)}>cancel</button>
      </li>
    {/each}
  </ol>
  <button onclick={() => queue.clear()}>Clear queue</button>
{/if}
```

`queue.size`, `queue.entries`, and `queue.clear` / `queue.cancel` are reactive — Svelte will re-render as entries come and go.
