# @langchain/svelte

Svelte SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It provides a `useStream` function that manages streaming, state, branching, and interrupts using Svelte stores.

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
| `submit(values, options?)` | `function` | Submit new input to the graph. When called while a stream is active, the run is created on the server with `multitaskStrategy: "enqueue"` and queued automatically. |
| `stop()` | `function` | Cancel the active stream. |
| `setBranch(branch)` | `function` | Switch to a different conversation branch. |
| `getMessagesMetadata(msg, index?)` | `function` | Get branching and checkpoint metadata for a message. |
| `switchThread(id)` | `(id: string \| null) => void` | Switch to a different thread. Pass `null` to start a new thread on next submit. |
| `queue.entries` | `Readable<ReadonlyArray<QueueEntry>>` | Pending server-side runs. Each entry has `id` (server run ID), `values`, `options`, and `createdAt`. |
| `queue.size` | `Writable<number>` | Number of pending runs on the server. |
| `queue.cancel(id)` | `(id: string) => Promise<boolean>` | Cancel a pending run on the server by its run ID. |
| `queue.clear()` | `() => Promise<void>` | Cancel all pending runs on the server. |

## Type Safety

Provide your state type as a generic parameter:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
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

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
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

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  import type { BaseMessage } from "langchain";

  const { messages, interrupt, submit } = useStream<
    { messages: BaseMessage[] },
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

## Server-Side Queuing

When `submit()` is called while a stream is already active, the SDK automatically creates the run on the server with `multitaskStrategy: "enqueue"`. The pending runs are tracked in `queue` and processed in order as each finishes:

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const { messages, submit, isLoading, queue, switchThread } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  const queueSize = queue.size;
  const queueEntries = queue.entries;
</script>

<div>
  {#each $messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  {#if $queueSize > 0}
    <div>
      <p>{$queueSize} message(s) queued</p>
      <button onclick={() => void queue.clear()}>Clear Queue</button>
    </div>
  {/if}

  <button
    disabled={$isLoading}
    onclick={() =>
      void submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
  <button onclick={() => switchThread(null)}>New Thread</button>
</div>
```

Switching threads via `switchThread()` cancels all pending runs and clears the queue.

## Stream Context

Use `setStreamContext` and `getStreamContext` to share a single `useStream` instance across a component tree without prop drilling. This uses Svelte's built-in `setContext` / `getContext` under the hood.

### Setting context in a parent

Call `setStreamContext` during component initialisation to provide the stream to all descendants:

```svelte
<script lang="ts">
  import { useStream, setStreamContext } from "@langchain/svelte";
  import ChatMessages from "./ChatMessages.svelte";
  import ChatInput from "./ChatInput.svelte";

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  setStreamContext(stream);
</script>

<ChatMessages />
<ChatInput />
```

### Consuming context in a child

Call `getStreamContext` in any descendant to retrieve the stream. The returned value has the same shape and types as the `useStream` return value:

```svelte
<script lang="ts">
  import { getStreamContext } from "@langchain/svelte";

  const { messages, isLoading } = getStreamContext();
</script>

{#each $messages as msg, i (msg.id ?? i)}
  <div>{msg.content}</div>
{/each}

{#if $isLoading}
  <p>Thinking…</p>
{/if}
```

```svelte
<script lang="ts">
  import { getStreamContext } from "@langchain/svelte";

  const { submit } = getStreamContext();

  let input = $state("");
</script>

<form onsubmit={(e) => { e.preventDefault(); void submit({ messages: [{ type: "human", content: input }] }); input = ""; }}>
  <input bind:value={input} />
  <button type="submit">Send</button>
</form>
```

### Type safety

`getStreamContext` accepts the same generic parameters as `useStream` so child components can be fully typed:

```svelte
<script lang="ts">
  import { getStreamContext } from "@langchain/svelte";
  import type { BaseMessage } from "@langchain/core/messages";

  interface MyState {
    messages: BaseMessage[];
    context?: string;
  }

  const { messages, values } = getStreamContext<MyState>();
</script>
```

`setStreamContext` returns the stream it was given, so you can combine the two calls:

```svelte
<script lang="ts">
  import { useStream, setStreamContext } from "@langchain/svelte";

  const { messages, submit } = setStreamContext(
    useStream({ assistantId: "agent", apiUrl: "http://localhost:2024" }),
  );
</script>
```

> **Note:** Both functions must be called during component initialisation (i.e. at the top level of a `<script>` block), just like Svelte's own `setContext` / `getContext`. Calling `getStreamContext` without a parent `setStreamContext` throws an error.

## Custom Transport

Instead of connecting to a LangGraph API, you can provide your own streaming transport. Pass a `transport` object instead of `assistantId` to use a custom backend:

```svelte
<script lang="ts">
  import { useStream, FetchStreamTransport } from "@langchain/svelte";
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

<div>
  {#each $messages as msg, i (msg.id ?? i)}
    {@const metadata = getMessagesMetadata(msg, i)}
    <div>
      <p>{msg.content}</p>
      {#if metadata?.streamMetadata}
        <span>Node: {metadata.streamMetadata.langgraph_node}</span>
      {/if}
    </div>
  {/each}

  <p>Current branch: {$branch}</p>

  <button
    disabled={$isLoading}
    onclick={() =>
      void submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
</div>
```

The custom transport interface returns the same properties as the standard `useStream` function, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management. `onFinish` is also supported and receives a synthetic `ThreadState` built from the final locally streamed values; the run metadata argument is `undefined`.

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
