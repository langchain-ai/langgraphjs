## Interrupts

When a graph pauses on an interrupt, `stream.interrupt` (and the full list in `stream.interrupts`) becomes reactive. Resume with `stream.respond(value)`.

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  import type { BaseMessage } from "@langchain/core/messages";

  const stream = useStream<
    { messages: BaseMessage[] },
    { question: string }
  >({ assistantId: "agent", apiUrl: "http://localhost:2024" });
</script>

{#if stream.interrupt}
  <p>{stream.interrupt.value.question}</p>
  <button onclick={() => stream.respond("Approved")}>Approve</button>
  <button onclick={() => stream.respond("Denied")}>Deny</button>
{/if}
```

### Targeting a specific interrupt

When multiple concurrent interrupts are in flight (subagents, fan-out, nested graphs), pass `{ interruptId, namespace? }`. Root interrupts can omit `namespace` (defaults to `[]`). Subgraph interrupts need the exact tuple from `getThread()?.interrupts`:

```ts
await stream.respond(
  { approved: true },
  { interruptId: myInterrupt.id! },
);

const thread = stream.getThread();
for (const entry of thread?.interrupts ?? []) {
  await stream.respond(buildResponse(entry.payload), {
    interruptId: entry.interruptId,
    namespace: entry.namespace,
  });
}
```

When `options.interruptId` is omitted, `respond()` walks `getThread()?.interrupts` from newest to oldest and resumes the first not yet resolved entry. That may be a root or subgraph interrupt — it is **not** necessarily `stream.interrupt` (`stream.interrupts[0]`, root-only). Safe when exactly one interrupt is pending.

Pass `options.config` / `options.metadata` to fold run-level config (model, user context, …) and metadata (trigger source, test flags, …) into the run that services the resume, mirroring `submit()`:

```ts
await stream.respond({ approved: true }, {
  config: { configurable: { model: "gpt-4o" } },
  metadata: { source: "ui" },
});
```

### Resuming several interrupts at once

When a run pauses on **several interrupts at the same checkpoint** (e.g. parallel tool-authorization prompts), resume them in one command with `respondAll`. Sequential `respond()` calls would fail — the first resume starts a run, leaving the rest with no interrupted run to respond to.

`responsesById` maps each pending `interruptId` to its response, so different interrupts can receive different payloads. Namespaces are resolved internally from `getThread()?.interrupts`, so you only supply ids. `options.config` / `options.metadata` are folded into the single run that services the batched resume.

```ts
// Distinct payloads per interrupt:
await stream.respondAll({
  [interruptA.id]: { approved: true },
  [interruptB.id]: { approved: false },
});

// Same payload to every pending interrupt:
await stream.respondAll(
  Object.fromEntries(stream.interrupts.map((i) => [i.id!, { approved: true }])),
);
```

### Stopping a run

`stream.stop()` aborts the in-flight run. The transport `AbortController` fires, the `messages` / `toolCalls` projections stop receiving deltas, and `values` reverts to the server's authoritative snapshot after reconciliation. Safe to call unconditionally — when no run is active it is a no-op.

```svelte
<button onclick={() => stream.stop()} disabled={!stream.isLoading}>Stop</button>
```

### `hydrationPromise`

`stream.hydrationPromise` resolves when the active thread's initial hydration completes. A fresh promise is installed whenever the bound `threadId` changes. Useful for SvelteKit `load()` handlers and SSR skeletons:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  const stream = useStream({ assistantId: "agent", apiUrl: "http://localhost:2024" });

  let hydrated = $state(false);
  $effect(() => {
    let cancelled = false;
    stream.hydrationPromise.then(() => { if (!cancelled) hydrated = true; });
    return () => { cancelled = true; };
  });
</script>
```
