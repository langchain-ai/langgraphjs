# @langchain/vue

Vue SDK for building AI-powered applications with [LangChain](https://js.langchain.com/) and [LangGraph](https://langchain-ai.github.io/langgraphjs/). Provides a `useStream` composable that manages streaming, state, branching, and interrupts using Vue's reactivity system.

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
    <div v-for="(msg, i) in messages.value" :key="msg.id ?? i">
      {{ msg.content }}
    </div>

    <button
      :disabled="isLoading.value"
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

All reactive properties are Vue `computed` or `ref` values.

| Property | Type | Description |
|---|---|---|
| `values` | `ComputedRef<StateType>` | Current graph state. |
| `messages` | `ComputedRef<Message[]>` | Messages from the current state. |
| `isLoading` | `Ref<boolean>` | Whether a stream is currently active. |
| `error` | `ComputedRef<unknown>` | The most recent error, if any. |
| `interrupt` | `ComputedRef<Interrupt \| undefined>` | Current interrupt requiring user input. |
| `branch` | `Ref<string>` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |

## Type Safety

Provide your state type as a generic parameter:

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";
import type { Message } from "@langchain/langgraph-sdk";

interface MyState {
  messages: Message[];
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
import type { Message } from "@langchain/langgraph-sdk";

const { interrupt, submit } = useStream<
  { messages: Message[] },
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
import type { Message } from "@langchain/langgraph-sdk";

const { messages, interrupt, submit } = useStream<
  { messages: Message[] },
  { InterruptType: { question: string } }
>({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});
</script>

<template>
  <div>
    <div v-for="(msg, i) in messages.value" :key="msg.id ?? i">
      {{ msg.content }}
    </div>

    <div v-if="interrupt.value">
      <p>{{ interrupt.value.value.question }}</p>
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
    <div v-for="(msg, i) in messages.value" :key="msg.id ?? i">
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

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangGraph Playground](https://github.com/langchain-ai/langgraphjs).

## License

MIT
