## Submission queue

When `submit()` is called while a run is already in flight, pass `multitaskStrategy: "enqueue"` to queue it on the server. The `useSubmissionQueue` composable exposes a reactive view of pending entries, plus helpers to cancel individual entries or clear the queue entirely.

```svelte
<script lang="ts">
  import { useStream, useSubmissionQueue } from "@langchain/svelte";
  import { Client } from "@langchain/langgraph-sdk";

  const client = new Client({ apiUrl: "http://localhost:2024" });
  const stream = useStream({ assistantId: "agent", client, serverQueue: client.runs });
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

## Server queue semantics

`submit(input, { multitaskStrategy: "enqueue" })` sends the input to the server immediately, even while another run is streaming. Its promise resolves on **server acceptance**, not completion; acceptance failures reject and also reach the per-submit `onError` callback and `stream.error`. The existing content stream stays attached. The server decides execution order; concurrent HTTP requests are not guaranteed to be accepted in invocation order.

Each entry has `{ id, runId?, values, options?, createdAt }`. Use `id` as the stable UI key and cancellation argument. `runId` is absent during acceptance and then contains the real server run ID. Message IDs are assigned before sending and preserved in `values`; queued inputs remain separate from the active run's optimistic state. Entries leave the queue when their own run starts or terminates. Queue completion callbacks are correlated using per-run status/join requests, not another run's terminal event.

Running runs are tracked separately for stop/completion and never appear as pending entries. Pending runs are restored from all pages of `runs.list` on hydration and refreshed on built-in transport reconnects. The SDK checks pending run status roughly once per second and joins running runs without cancelling on disconnect. Restored entries use the server run ID as their UI key. `values` is `undefined` if the server does not return `kwargs.input`; stored input is not guaranteed. Only available config/metadata are restored, not JavaScript callbacks. Hydration includes pending runs submitted by other clients on the same thread.

`cancel(id): Promise<boolean>` cancels that entry's server run, waiting for acceptance if necessary. `clear(): Promise<void>` cancels the current queue snapshot with explicit run IDs, leaving later submissions and unrelated active runs alone. Cancellation failures reject and leave entries available for retry. A run may start between observation and cancellation; cancelling that entry can then interrupt it.

Switching threads or unmounting clears only this client's mirror and detaches observers. **Accepted runs keep executing on their original thread.** Reopening that thread restores its pending queue. To cancel before leaving, explicitly await `clear()`.

Server queues are **opt-in**: pass `serverQueue: client.runs` to the stream options, or implement `transport.serverQueue` on a custom adapter. The capability supplies `list`, `get`, `join`, `cancel`, and `cancelMany`; it must target the same server with the same authentication and fetch policy as the protocol transport. There is no implicit REST fallback. Without it, hydration makes no queue requests and enqueue rejects. Custom adapters can refresh via controller hydration when reconnecting.

Enqueue uses the existing protocol `run.start` command, which configures v2 stream modes, subgraphs, and resumability on both JS and Python servers. It does not use REST `runs.create`. Ordinary (non-enqueue) submissions retain their stream-only completion path and do not acquire GET/join requirements. If their terminal stream event is permanently lost, use reconnect or stop; queue polling is not a general replacement for stream lifecycle delivery.

`stop()` with this capability looks up the current server-running run rather than cancelling pending entries. When no run is running yet, it waits for in-flight local queue acceptances and checks once more. This is not an atomic server-side “cancel whichever run starts next” operation: a run still pending at that check is left alone. Use `cancel(entry.id)` to cancel a specific pending submission. Cancellation failures from `stop()` do not prevent client-side stopping.

With the capability enabled, passive completion callbacks come from observed server run IDs, not anonymous terminal events. Runs created by another client after hydration are discovered on a root running event or reconnect; runs that begin and finish entirely outside these observation windows are not guaranteed callbacks. The embedded protocol-only server does not expose the full queue observation API and is not a supported `serverQueue: client.runs` target.
