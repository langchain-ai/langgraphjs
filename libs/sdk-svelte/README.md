# @langchain/svelte

Svelte SDK for building AI-powered applications with [LangChain](https://js.langchain.com/) and [LangGraph](https://langchain-ai.github.io/langgraphjs/). Provides a `useStream` function that manages streaming, state, branching, and interrupts using Svelte stores.

## Installation

```bash
npm install @langchain/svelte @langchain/core
```

**Peer dependencies:** `svelte` (^4.0.0 || ^5.0.0), `@langchain/core` (^1.0.1)

## Quick Start

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const { messages, submit, isLoading } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<div>
  {#each $messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  <button
    disabled={$isLoading}
    onclick={() =>
      void submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
</div>
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

Reactive properties are Svelte `writable` or `derived` stores. Access their values in templates with the `$` prefix.

| Property | Type | Description |
|---|---|---|
| `values` | `Readable<StateType>` | Current graph state. |
| `messages` | `Readable<Message[]>` | Messages from the current state. |
| `isLoading` | `Writable<boolean>` | Whether a stream is currently active. |
| `error` | `Readable<unknown>` | The most recent error, if any. |
| `interrupt` | `Readable<Interrupt \| undefined>` | Current interrupt requiring user input. |
| `branch` | `Writable<string>` | Active branch identifier. |
| `submit(values, options?)` | `function` | Submit new input to the graph. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |

## Type Safety

Provide your state type as a generic parameter:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
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

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
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

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  import type { Message } from "@langchain/langgraph-sdk";

  const { messages, interrupt, submit } = useStream<
    { messages: Message[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<div>
  {#each $messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  {#if $interrupt}
    <div>
      <p>{$interrupt.value.question}</p>
      <button onclick={() => void submit(null, { command: { resume: "Approved" } })}>
        Approve
      </button>
    </div>
  {/if}

  <button
    onclick={() =>
      void submit({ messages: [{ type: "human", content: "Hello" }] })}
  >
    Send
  </button>
</div>
```

## Branching

Enable conversation branching with `fetchStateHistory: true`:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const { messages, submit, getMessagesMetadata, setBranch } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    fetchStateHistory: true,
  });
</script>

<div>
  {#each $messages as msg, i (msg.id ?? i)}
    {@const metadata = getMessagesMetadata(msg, i)}
    {@const branchOptions = metadata?.branchOptions}
    {@const branch = metadata?.branch}

    <div>
      <p>{msg.content}</p>

      {#if branchOptions && branch}
        <button onclick={() => {
          const prev = branchOptions[branchOptions.indexOf(branch) - 1];
          if (prev) setBranch(prev);
        }}>
          Previous
        </button>
        <span>
          {branchOptions.indexOf(branch) + 1} / {branchOptions.length}
        </span>
        <button onclick={() => {
          const next = branchOptions[branchOptions.indexOf(branch) + 1];
          if (next) setBranch(next);
        }}>
          Next
        </button>
      {/if}
    </div>
  {/each}

  <button
    onclick={() =>
      void submit({ messages: [{ type: "human", content: "Hello" }] })}
  >
    Send
  </button>
</div>
```

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangGraph Playground](https://github.com/langchain-ai/langgraphjs).

## License

MIT
