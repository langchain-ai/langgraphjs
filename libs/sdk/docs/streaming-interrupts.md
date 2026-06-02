# Interrupts & human-in-the-loop

LangGraph graphs can pause mid-execution to request input from a human
(or any external actor). The SDK surfaces these as **interrupts** on
the `ThreadStream` and lets you resume them with
`thread.input.respond(...)`.

Interrupts are first-class on the `ThreadStream`:

```ts
thread.interrupted;          // boolean, true after a "lifecycle: interrupted" event
thread.interrupts;           // InterruptPayload[], filled by "input.requested" events
```

Both are synchronous snapshots updated as events flow in, no subscription
setup required — the SDK opens a dedicated lifecycle watcher as soon as
you call `run.start` or `input.respond`.

## The `InterruptPayload` shape

```ts
interface InterruptPayload<TPayload = unknown> {
  interruptId: string;    // stable id for targeted resume
  payload: TPayload;      // whatever the graph emitted via `interrupt(...)`
  namespace: string[];    // subgraph namespace (empty at the root)
}
```

## End-to-end example

```ts
import { Client } from "@langchain/langgraph-sdk";

const client = new Client({ apiUrl: "http://localhost:2024" });
const thread = client.threads.stream({ assistantId: "human-in-the-loop" });

// Access `values` eagerly so we can watch snapshots before AND after
// the resume — a single `values` projection survives across runs.
const values = thread.values;

await thread.run.start({
  input: {
    messages: [
      { role: "user", content: "Send a release update email" },
    ],
  },
});

for await (const snapshot of values) {
  const state = snapshot as { messages?: unknown[] };
  console.log(`snapshot: ${state.messages?.length ?? 0} messages`);
  if (thread.interrupted) break;
}

if (thread.interrupted) {
  for (const interrupt of thread.interrupts) {
    console.log("pending interrupt:", interrupt.interruptId);
    console.log("  payload:", interrupt.payload);

    await thread.input.respond({
      namespace: interrupt.namespace,
      interrupt_id: interrupt.interruptId,
      response: { approved: true },
    });
  }

  // The same `values` iterator picks up right where it left off.
  for await (const snapshot of values) {
    console.log("resumed snapshot:", snapshot);
  }
}

console.log("final:", await thread.output);
await thread.close();
```

## Key semantics

### Paused subscriptions auto-resume

When the run reaches a terminal lifecycle state (`interrupted`,
`completed`, or `failed`), all active non-lifecycle subscriptions are
**paused** — `for await` loops exit cleanly without error. As soon as
you call `thread.input.respond(...)` (or start a new `run.start`), the
SDK resumes those subscriptions and fresh iterators resume consumption.

This is why the pattern above works: one `values` handle spans the
initial run, the interrupt, and the resume.

### Targeted resume with namespace

Subgraph interrupts carry a non-empty `namespace`. Forward it verbatim:

```ts
await thread.input.respond({
  namespace: interrupt.namespace,  // e.g. ["researcher"]
  interrupt_id: interrupt.interruptId,
  response: { decision: "approve" },
});
```

The SDK / server routes the response to the correct paused subgraph.

### Injecting input mid-run

`thread.input.inject(...)` pushes input into a running graph without
waiting for an interrupt. Use it to push user intent into long-running
or background runs:

```ts
await thread.input.inject({
  namespace: [],
  data: { userEvent: "cancel" },
});
```

Inject is best for cooperative cancellation and side-channel signals;
for mainstream chat flows prefer `run.start` or `input.respond`.

## Dealing with multiple interrupts

A single run can produce multiple concurrent interrupts — for example
a deep agent fans out to several subagents that each pause. Iterate
`thread.interrupts` and respond to each:

```ts
for (const interrupt of thread.interrupts) {
  const payload = interrupt.payload as { actionRequests?: { name: string }[] };
  const decisions = (payload.actionRequests ?? []).map((r) => ({
    action: r.name,
    type: "approve" as const,
  }));

  await thread.input.respond({
    namespace: interrupt.namespace,
    interrupt_id: interrupt.interruptId,
    response: { decisions },
  });
}
```

## Detecting interrupts in streaming loops

A common UI pattern: loop over messages until the run interrupts, then
branch into a review UI.

```ts
for await (const message of thread.messages) {
  for await (const token of message.text) {
    ui.appendToken(token);
  }
  if (thread.interrupted) break;
}

if (thread.interrupted) {
  await presentInterruptsToUser(thread.interrupts);
}
```

Because `thread.interrupted` is a plain synchronous field, the check
is safe anywhere in a consumer loop — the server's
`lifecycle: interrupted` event is applied before your loop runs again.

## Related

- [Messages & tokens](./streaming-messages.md) — the `thread.messages`
  projection that pairs naturally with interrupts.
- Framework-specific higher-level flows (headless tools, automatic
  interrupt routing):
  - [`@langchain/react` interrupts](../../sdk-react/docs/interrupts.md)
  - [`@langchain/svelte` interrupts](../../sdk-svelte/docs/interrupts.md)
