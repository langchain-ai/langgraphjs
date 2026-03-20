# @langchain/vue

Vue SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It provides a `useStream` composable that manages streaming, state, branching, and interrupts using Vue's reactivity system.

## Installation

```bash
npm install @langchain/vue @langchain/core
```

**Peer dependencies:** `vue` (^3.0.0), `@langchain/core` (^1.0.1)

## Quick Start

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const { messages, submit, isLoading } = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages" :key="msg.id ?? i">
      {{ msg.content }}
    </div>

    <button
      :disabled="isLoading"
      @click="submit({ messages: [{ type: 'human', content: 'Hello!' }] })"
    >
      Send
    </button>
  </div>
</template>
```

## `useStream` Options

| Option | Type | Description |
|---|---|---|
| `assistantId` | `string` | **Required.** The assistant/graph ID to stream from. |
| `apiUrl` | `string` | Base URL of the LangGraph API. |
| `client` | `Client` | Pre-configured `Client` instance (alternative to `apiUrl`). |
| `messagesKey` | `string` | State key containing messages. Defaults to `"messages"`. |
| `initialValues` | `StateType` | Initial state values before any stream data arrives. |
| `fetchStateHistory` | `boolean \| { limit: number }` | Fetch thread history on stream completion. Enables branching. |
| `throttle` | `boolean \| number` | Throttle state updates for performance. |
| `onFinish` | `(state, error?) => void` | Called when the stream completes. |
| `onError` | `(error, state?) => void` | Called on stream errors. |
| `onThreadId` | `(threadId) => void` | Called when a new thread is created. |
| `onUpdateEvent` | `(event) => void` | Receive update events from the stream. |
| `onCustomEvent` | `(event) => void` | Receive custom events from the stream. |
| `onStop` | `() => void` | Called when the stream is stopped by the user. |

## Return Values

All reactive properties are Vue `computed` or `ref` values that [auto-unwrap](https://vuejs.org/guide/essentials/reactivity-fundamentals.html#ref-unwrapping-in-templates) in `<template>` blocks — use them directly (e.g. `messages`, not `messages.value`). The `queue` object is `reactive`, so its nested properties also auto-unwrap in templates.

| Property | Type | Description |
|---|---|---|
| `values` | `ComputedRef<StateType>` | Current graph state. |
| `messages` | `ComputedRef<Message[]>` | Messages from the current state. |
| `isLoading` | `Ref<boolean>` | Whether a stream is currently active. |
| `error` | `ComputedRef<unknown>` | The most recent error, if any. |
| `interrupt` | `ComputedRef<Interrupt \| undefined>` | Current interrupt requiring user input. |
| `branch` | `Ref<string>` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. When called while a stream is active, the run is created on the server with `multitaskStrategy: "enqueue"` and queued automatically. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |
| `switchThread(id)` | `(id: string \| null) => void` | Switch to a different thread. Pass `null` to start a new thread on next submit. |
| `queue.entries` | `ReadonlyArray<QueueEntry>` | Pending server-side runs. Each entry has `id` (server run ID), `values`, `options`, and `createdAt`. |
| `queue.size` | `number` | Number of pending runs on the server. |
| `queue.cancel(id)` | `(id: string) => Promise<boolean>` | Cancel a pending run on the server by its run ID. |
| `queue.clear()` | `() => Promise<void>` | Cancel all pending runs on the server. |

## Type Safety

Provide your state type as a generic parameter:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { BaseMessage } from "langchain";

interface MyState {
  messages: BaseMessage[];
  context?: string;
}

const { messages, submit } = useStream<MyState>({
  assistantId: "my-graph",
  apiUrl: "http://localhost:2024",
});
</script>
```

### Typed Interrupts

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { BaseMessage } from "langchain";

const { interrupt, submit } = useStream<
  { messages: BaseMessage[] },
  { InterruptType: { question: string } }
>({
  assistantId: "my-graph",
  apiUrl: "http://localhost:2024",
});
</script>
```

## Handling Interrupts

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { BaseMessage } from "langchain";

const { messages, interrupt, submit } = useStream<
  { messages: BaseMessage[] },
  { InterruptType: { question: string } }
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages" :key="msg.id ?? i">
      {{ msg.content }}
    </div>

    <div v-if="interrupt">
      <p>{{ interrupt.value.question }}</p>
      <button @click="submit(null, { command: { resume: 'Approved' } })">
        Approve
      </button>
    </div>

    <button
      @click="submit({ messages: [{ type: 'human', content: 'Hello' }] })"
    >
      Send
    </button>
  </div>
</template>
```

## Branching

Enable conversation branching with `fetchStateHistory: true`:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const { messages, submit, getMessagesMetadata, setBranch } = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
  fetchStateHistory: true,
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages" :key="msg.id ?? i">
      <p>{{ msg.content }}</p>

      <template v-if="getMessagesMetadata(msg, i)?.branchOptions">
        <button
          @click="() => {
            const meta = getMessagesMetadata(msg, i);
            const prev = meta.branchOptions[meta.branchOptions.indexOf(meta.branch) - 1];
            if (prev) setBranch(prev);
          }"
        >
          Previous
        </button>
        <button
          @click="() => {
            const meta = getMessagesMetadata(msg, i);
            const next = meta.branchOptions[meta.branchOptions.indexOf(meta.branch) + 1];
            if (next) setBranch(next);
          }"
        >
          Next
        </button>
      </template>
    </div>

    <button
      @click="submit({ messages: [{ type: 'human', content: 'Hello' }] })"
    >
      Send
    </button>
  </div>
</template>
```

## Server-Side Queuing

When `submit()` is called while a stream is already active, the SDK automatically creates the run on the server with `multitaskStrategy: "enqueue"`. The pending runs are tracked in `queue` and processed in order as each finishes:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const { messages, submit, isLoading, queue, switchThread } = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages" :key="msg.id ?? i">
      {{ msg.content }}
    </div>

    <div v-if="queue.size > 0">
      <p>{{ queue.size }} message(s) queued</p>
      <button @click="queue.clear()">Clear Queue</button>
    </div>

    <button
      :disabled="isLoading"
      @click="submit({ messages: [{ type: 'human', content: 'Hello!' }] })"
    >
      Send
    </button>
    <button @click="switchThread(null)">New Thread</button>
  </div>
</template>
```

Switching threads via `switchThread()` cancels all pending runs and clears the queue.

## Custom Transport

Instead of connecting to a LangGraph API, you can provide your own streaming transport. Pass a `transport` object instead of `assistantId` to use a custom backend:

```vue
<script setup lang="ts">
import { useStream, FetchStreamTransport } from "@langchain/vue";
import type { BaseMessage } from "langchain";

const {
  messages,
  submit,
  isLoading,
  branch,
  setBranch,
  getMessagesMetadata,
} = useStream<{ messages: BaseMessage[] }>({
  transport: new FetchStreamTransport({
    url: "https://my-api.example.com/stream",
  }),
  threadId: null,
  onThreadId: (id) => console.log("Thread created:", id),
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages" :key="msg.id ?? i">
      <p>{{ msg.content }}</p>
      <span v-if="getMessagesMetadata(msg, i)?.streamMetadata">
        Node: {{ getMessagesMetadata(msg, i)?.streamMetadata?.langgraph_node }}
      </span>
    </div>

    <p>Current branch: {{ branch }}</p>

    <button
      :disabled="isLoading"
      @click="submit({ messages: [{ type: 'human', content: 'Hello!' }] })"
    >
      Send
    </button>
  </div>
</template>
```

The custom transport interface returns the same properties as the standard `useStream` composable, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management. `onFinish` is also supported and receives a synthetic `ThreadState` built from the final locally streamed values; the run metadata argument is `undefined`.

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
