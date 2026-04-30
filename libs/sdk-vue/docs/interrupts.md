# Interrupts & headless tools

Pause graph execution and wait for user input (or an in-browser tool
handler). Interrupts surface as `stream.interrupt` / `stream.interrupts`
and can be resumed by either calling `submit(null, { command })` or
the more explicit `respond()`.

## Handling interrupts from the UI

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { BaseMessage } from "@langchain/core/messages";

const stream = useStream<
  { messages: BaseMessage[] },
  { question: string }
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

function onSubmit() {
  void stream.submit({ messages: [{ type: "human", content: "Hello" }] });
}

function onResume() {
  void stream.submit(null, { command: { resume: "Approved" } });
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

  <button @click="onSubmit">Send</button>
</template>
```

## Resuming a specific interrupt

When multiple interrupts are active (subagents, fan-out, nested
graphs), use `respond(value, { interruptId })` instead of
`submit(null, { command })`:

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
