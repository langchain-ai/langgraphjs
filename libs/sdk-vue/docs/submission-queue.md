# Submission queue

Calling `submit` with `multitaskStrategy: "enqueue"` while a run is
already in flight queues the new payload. `useSubmissionQueue`
exposes the queue as a set of refs + imperatives:

```vue
<script setup lang="ts">
import { useStream, useSubmissionQueue } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
const queue = useSubmissionQueue(stream);

function onSubmit() {
  void stream.submit(
    { messages: [{ type: "human", content: "Hello!" }] },
    { multitaskStrategy: "enqueue" },
  );
}
</script>

<template>
  <div v-for="(msg, i) in stream.messages" :key="msg.id ?? i">
    {{ typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }}
  </div>

  <div v-if="queue.size > 0">
    <p>{{ queue.size }} run(s) queued</p>
    <button
      v-for="entry in queue.entries"
      :key="entry.id"
      @click="queue.cancel(entry.id)"
    >
      Cancel {{ entry.id }}
    </button>
    <button @click="queue.clear()">Clear queue</button>
  </div>

  <button @click="onSubmit">Send</button>
</template>
```

## API

`useSubmissionQueue(stream)` returns:

| Field | Type | Description |
|---|---|---|
| `entries` | `Readonly<ShallowRef<SubmissionQueueEntry[]>>` | Current queue, oldest first. |
| `size` | `ComputedRef<number>` | Convenience — `entries.value.length`. |
| `cancel(id)` | `(id: string) => void` | Remove a specific entry. |
| `clear()` | `() => void` | Remove all pending entries. |

## Thread switching

Swapping the reactive `threadId` passed to `useStream` cancels all
pending runs and clears the queue automatically — no manual
bookkeeping required.
