# Interrupts & headless tools

Interrupts pause graph execution and wait for user input (or an
in-browser tool handler). `@langchain/vue` surfaces them on
`stream.interrupt` / `stream.interrupts` and lets you resume them with
`stream.respond()`.

## Table of contents

- [Reading interrupts](#reading-interrupts)
- [Script vs template access](#script-vs-template-access)
- [Human-in-the-loop (HITL)](#human-in-the-loop-hitl)
- [Resuming an interrupt](#resuming-an-interrupt)
- [`respond(response, options?)`](#respondresponse-options)
- [Changing state while resuming](#changing-state-while-resuming)
- [`respondAll(responsesById, options?)`](#respondallresponsesbyid-options)
- [Stopping a run](#stopping-a-run)
- [Headless tools](#headless-tools)

## Reading interrupts

The root composable exposes the latest interrupt and the full list.
Each entry is an SDK `Interrupt<TValue>` object:

```ts
interface Interrupt<TValue = unknown> {
  id?: string;
  value?: TValue; // ← your interrupt payload lives here
}
```

Type the payload with the second generic to `useStream`:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { BaseMessage } from "@langchain/core/messages";

const stream = useStream<
  { messages: BaseMessage[] },
  { question: string } // InterruptType
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

function onSubmit() {
  void stream.submit({ messages: [{ type: "human", content: "Hello" }] });
}

function onResume() {
  void stream.respond("Approved");
}
</script>

<template>
  <div v-for="(msg, i) in stream.messages" :key="msg.id ?? i">
    {{ typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }}
  </div>

  <div v-if="stream.interrupt">
    <p>{{ stream.interrupt.value.question }}</p>
    <button @click="onResume">Approve</button>
  </div>

  <button :disabled="stream.isLoading" @click="onSubmit">Send</button>
</template>
```

## Script vs template access

Unlike `@langchain/react`, `@langchain/svelte`, and `@langchain/angular`,
the Vue composable wraps reactive fields in `ShallowRef` /
`ComputedRef`. That adds one extra `.value` in `<script setup>` when
you read the interrupt **payload**.

| Location | Access pattern | Resolves to |
|---|---|---|
| `<template>` | `stream.interrupt.value.question` | Payload field (`question`) |
| `<script setup>` | `stream.interrupt.value?.value` | Full payload object |
| `<script setup>` (recommended) | `computed(() => stream.interrupt.value?.value)` | Reactive payload |

In templates, Vue auto-unwraps refs on the stream handle, so the first
`.value` reads the SDK `Interrupt.value` payload — the same ergonomics
as React's `interrupt.value.question`.

In script, the first `.value` unwraps the Vue `ComputedRef` and returns
the `Interrupt` object. Read the payload with a **second** `.value`:

```vue
<script setup lang="ts">
import { computed } from "vue";
import { useStream } from "@langchain/vue";

const stream = useStream<
  { messages: BaseMessage[] },
  { question: string }
>({ assistantId: "agent", apiUrl: "http://localhost:2024" });

// ✅ Correct — unwrap Vue ref, then Interrupt payload
const question = computed(() => stream.interrupt.value?.value?.question);

// ❌ Wrong — this is the Interrupt wrapper, not the payload
// const question = stream.interrupt.value?.question;
</script>
```

Prefer a `computed` for anything you render or pass to handlers so the
payload stays reactive and you avoid repeating the double unwrap.

## Human-in-the-loop (HITL)

When using LangChain's
[`humanInTheLoopMiddleware`](https://docs.langchain.com/oss/javascript/langchain/middleware/human-in-the-loop),
the interrupt payload is a `HITLRequest` (action requests, review
configs, allowed decisions). Import the types from `langchain` and
unwrap the payload in script with `stream.interrupt.value?.value`:

```vue
<script setup lang="ts">
import { computed, ref } from "vue";
import { useStream } from "@langchain/vue";
import {
  AIMessage,
  HumanMessage,
  type HITLRequest,
  type HITLResponse,
} from "langchain";
import type { BaseMessage } from "@langchain/core/messages";

const stream = useStream<
  { messages: BaseMessage[] },
  HITLRequest
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

const isProcessing = ref(false);
const hitlRequest = computed(
  () => stream.interrupt.value?.value as HITLRequest | undefined,
);
const actionRequests = computed(() => hitlRequest.value?.actionRequests ?? []);

async function onApprove() {
  if (!hitlRequest.value) return;
  isProcessing.value = true;
  try {
    const resume: HITLResponse = {
      decisions: actionRequests.value.map(() => ({ type: "approve" })),
    };
    await stream.respond(resume);
  } finally {
    isProcessing.value = false;
  }
}
</script>

<template>
  <div v-for="msg in stream.messages" :key="msg.id">
    <div v-if="HumanMessage.isInstance(msg)">{{ msg.text }}</div>
    <div v-else-if="AIMessage.isInstance(msg) && msg.text">{{ msg.text }}</div>
  </div>

  <div v-if="hitlRequest && actionRequests.length > 0 && !isProcessing">
    <!-- render ApprovalCard per actionRequests[i] -->
    <button @click="onApprove">Approve</button>
  </div>
</template>
```

Use `hitlRequest` (the unwrapped payload) for `:disabled`,
`:placeholder`, and conditional UI — not `stream.interrupt` itself,
which is always a ref object and stays truthy even when no interrupt
is pending.

## Resuming an interrupt

Call `stream.respond(value)` when exactly one interrupt is pending:

```ts
void stream.respond("Approved");

void stream.respond({
  decisions: [{ type: "approve" }],
});
```

When multiple interrupts can be active, pass an explicit target — see [Multiple pending interrupts](#multiple-pending-interrupts) and [Subgraph interrupts and namespace](#subgraph-interrupts-and-namespace).

## Multiple pending interrupts

When `options.interruptId` is omitted, `respond()` walks `stream.getThread()?.interrupts` from **newest to oldest** and resumes the first entry whose `interruptId` has not already been resolved. That list includes root **and** subgraph interrupts. It is **not** the same as `stream.interrupt` / `stream.interrupts[0]`, which only mirror root-namespace interrupts.

| Surface | What it contains | Use for |
| ------- | ---------------- | ------- |
| `stream.interrupts` | Root-namespace interrupts (`{ id, value }`) | Rendering root HITL UI |
| `stream.getThread()?.interrupts` | All protocol interrupts (`{ interruptId, payload, namespace }`) | Targeting + namespace for `respond()` |

```ts
for (const intr of stream.interrupts.value) {
  await stream.respond(decide(intr.value), { interruptId: intr.id! });
}
```

## Subgraph interrupts and namespace

Subgraph interrupts carry a non-empty protocol `namespace` tuple (for example `["task:research"]`). The server validates it on resume. Read it from `getThread()?.interrupts` — nested entries may not appear on `stream.interrupts`:

```ts
const thread = stream.getThread();
for (const entry of thread?.interrupts ?? []) {
  await stream.respond(buildResponse(entry.payload), {
    interruptId: entry.interruptId,
    namespace: entry.namespace,
  });
}
```

## `respond(response, options?)`

When multiple interrupts are active (subagents, fan-out, nested graphs), pass `options.interruptId` (and `options.namespace` for subgraph interrupts):

```ts
await stream.respond({ approved: true });

await stream.respond(
  { approved: true },
  { interruptId: myInterrupt.id!, namespace: entry.namespace },
);
```

When `options.interruptId` is omitted, the newest unresolved entry in `getThread()?.interrupts` is resumed — not necessarily the most recent root interrupt on `stream.interrupt`.

Pass `options.config` / `options.metadata` to fold run-level config (model, user context, …) and metadata (trigger source, test flags, …) into the run that services the resume, mirroring `submit()`:

```ts
await stream.respond({ approved: true }, {
  config: { configurable: { model: "gpt-4o" } },
  metadata: { source: "ui" },
});
```

## Changing state while resuming

Pass `options.update` to apply a state update in the **same superstep** as the resume — it maps to LangGraph's `Command(resume, update)`. The resumed run produces a single checkpoint reflecting both the resume value and the update: no separate `updateState` write, no intermediate checkpoint, no flicker.

The canonical use case is a HITL flow where the UI pushes the interrupt card (e.g. an `AIMessage`) into state at the moment it answers the interrupt, so the card is committed before the resumed tool runs and stays rendered without the backend re-emitting it.

`update` accepts a state-keys object (shallow-merged via the graph's channel reducers) or a list of `[key, value]` entries. Messages under the configured `messagesKey` may be plain dicts **or** `@langchain/core` `BaseMessage` instances — instances are serialized to dicts before transport, exactly like `submit()`. You can also pass `options.goto` for a directed jump (`Command(goto=...)`) in the same superstep.

```ts
import { AIMessage } from "@langchain/core/messages";

// Approve the interrupt AND push a message into state in one atomic resume:
await stream.respond(
  { approved: true },
  { update: { messages: [new AIMessage("Approved by reviewer.")] } },
);

// Equivalent with a plain message dict:
await stream.respond(
  { approved: true },
  { update: { messages: [{ type: "ai", content: "Approved by reviewer." }] } },
);
```

## `respondAll(responsesById, options?)`

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
  Object.fromEntries(stream.interrupts.value.map((i) => [i.id!, { approved: true }])),
);
```

## Stopping a run

`stream.stop()` aborts the in-flight run. The transport
`AbortController` fires, the `messages` / `toolCalls` projections
stop receiving deltas, and `values` reverts to the server's
authoritative snapshot after reconciliation. Safe to call
unconditionally — when no run is active it is a no-op.

```vue
<button :disabled="!stream.isLoading" @click="() => void stream.stop()">
  Stop
</button>
```

## Headless tools

Register browser-side tool implementations with `tools` / `onTool`.
Interrupts that target a registered tool are invoked and auto-resumed
with the handler's return value — no template plumbing needed.

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import { tool } from "langchain";
import { z } from "zod";

const getCurrentLocation = tool(
  async () => ({ lat: 40.71, lon: -74.01 }),
  {
    name: "get_current_location",
    schema: z.object({}),
  },
);

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  tools: [getCurrentLocation],
  onTool: (event) => {
    if (event.type === "error") console.error(event.error);
  },
});
</script>
```

Dedupe is automatic — the same interrupt observed twice is invoked
only once.
