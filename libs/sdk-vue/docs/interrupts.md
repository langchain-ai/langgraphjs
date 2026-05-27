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
- [`respond(response, target?)`](#respondresponse-target)
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

Call `stream.respond(value)` to resume the most-recent root interrupt:

```ts
void stream.respond("Approved");

void stream.respond({
  decisions: [{ type: "approve" }],
});
```

When multiple interrupts are active, pass an explicit target (see below).

## `respond(response, target?)`

When multiple interrupts are active (subagents, fan-out, nested
graphs), use `respond(value, { interruptId })`:

```ts
await stream.respond({ approved: true });

await stream.respond(
  { approved: true },
  { interruptId: myInterrupt.id, namespace: ["subagent"] },
);
```

When `target` is omitted, the most recent root interrupt is resumed.

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
