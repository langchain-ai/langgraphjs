# @langchain/svelte

Svelte SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview). It provides a `useStream` function that manages streaming, state, branching, and interrupts with a Svelte 5 runes-compatible reactive API.

## Installation

```bash
npm install @langchain/svelte @langchain/core
```

**Peer dependencies:** `svelte` (^5.0.0), `@langchain/core` (^1.0.1)

## Quick Start

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  <button
    disabled={stream.isLoading}
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
</div>
```

All reactive properties (`messages`, `isLoading`, `values`, etc.) are accessed directly on the returned object — no `$` prefix needed. Avoid destructuring reactive properties; use `stream.messages` instead of `const { messages } = stream` to keep reactivity intact.

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

All reactive properties are exposed as getters on the returned object. They update automatically and can be read directly in Svelte 5 templates without the `$` prefix.

| Property | Type | Description |
|---|---|---|
| `values` | `StateType` | Current graph state. |
| `messages` | `BaseMessage[]` | Messages from the current state. |
| `isLoading` | `boolean` | Whether a stream is currently active. |
| `error` | `unknown` | The most recent error, if any. |
| `interrupt` | `Interrupt \| undefined` | Current interrupt requiring user input. |
| `branch` | `string` | Active branch identifier. |
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

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";
  import type { BaseMessage } from "langchain";

  interface MyState {
    messages: BaseMessage[];
    context?: string;
  }

  const stream = useStream<MyState>({
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

  const stream = useStream<
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

  const stream = useStream<
    { messages: BaseMessage[] },
    { InterruptType: { question: string } }
  >({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  {#if stream.interrupt}
    <div>
      <p>{stream.interrupt.value.question}</p>
      <button onclick={() => void stream.submit(null, { command: { resume: "Approved" } })}>
        Approve
      </button>
    </div>
  {/if}

  <button
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hello" }] })}
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

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
    fetchStateHistory: true,
  });
</script>

<div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    {@const metadata = stream.getMessagesMetadata(msg, i)}
    {@const branchOptions = metadata?.branchOptions}
    {@const currentBranch = metadata?.branch}

    <div>
      <p>{msg.content}</p>

      {#if branchOptions && currentBranch}
        <button onclick={() => {
          const prev = branchOptions[branchOptions.indexOf(currentBranch) - 1];
          if (prev) stream.setBranch(prev);
        }}>
          Previous
        </button>
        <span>
          {branchOptions.indexOf(currentBranch) + 1} / {branchOptions.length}
        </span>
        <button onclick={() => {
          const next = branchOptions[branchOptions.indexOf(currentBranch) + 1];
          if (next) stream.setBranch(next);
        }}>
          Next
        </button>
      {/if}
    </div>
  {/each}

  <button
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hello" }] })}
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

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    <div>{msg.content}</div>
  {/each}

  {#if stream.queue.size > 0}
    <div>
      <p>{stream.queue.size} message(s) queued</p>
      <button onclick={() => void stream.queue.clear()}>Clear Queue</button>
    </div>
  {/if}

  <button
    disabled={stream.isLoading}
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
  <button onclick={() => stream.switchThread(null)}>New Thread</button>
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

  const stream = getStreamContext();
</script>

{#each stream.messages as msg, i (msg.id ?? i)}
  <div>{msg.content}</div>
{/each}

{#if stream.isLoading}
  <p>Thinking…</p>
{/if}
```

```svelte
<script lang="ts">
  import { getStreamContext } from "@langchain/svelte";

  const stream = getStreamContext();

  let input = $state("");
</script>

<form onsubmit={(e) => { e.preventDefault(); void stream.submit({ messages: [{ type: "human", content: input }] }); input = ""; }}>
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

  const stream = getStreamContext<MyState>();
</script>
```

`setStreamContext` returns the stream it was given, so you can inline both calls:

```svelte
<script lang="ts">
  import { useStream, setStreamContext } from "@langchain/svelte";

  const stream = setStreamContext(
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

  const stream = useStream<{ messages: BaseMessage[] }>({
    transport: new FetchStreamTransport({
      url: "https://my-api.example.com/stream",
    }),
    threadId: null,
    onThreadId: (id) => console.log("Thread created:", id),
  });
</script>

<div>
  {#each stream.messages as msg, i (msg.id ?? i)}
    {@const metadata = stream.getMessagesMetadata(msg, i)}
    <div>
      <p>{msg.content}</p>
      {#if metadata?.streamMetadata}
        <span>Node: {metadata.streamMetadata.langgraph_node}</span>
      {/if}
    </div>
  {/each}

  <p>Current branch: {stream.branch}</p>

  <button
    disabled={stream.isLoading}
    onclick={() =>
      void stream.submit({ messages: [{ type: "human", content: "Hello!" }] })}
  >
    Send
  </button>
</div>
```

The custom transport interface returns the same properties as the standard `useStream` function, including `getMessagesMetadata`, `branch`, `setBranch`, `switchThread`, and all message/interrupt/subagent helpers. When using a custom transport, `getMessagesMetadata` returns stream metadata sent alongside messages during streaming; `branch` and `setBranch` provide local branch state management. `onFinish` is also supported and receives a synthetic `ThreadState` built from the final locally streamed values; the run metadata argument is `undefined`.

## Sharing State with `provideStream`

When multiple components need access to the same stream (a message list, a header, an input bar), use `provideStream` and `getStream` to share a single stream instance via Svelte's context API:

```svelte
<!-- ChatContainer.svelte -->
<script lang="ts">
  import { provideStream } from "@langchain/svelte";
  import ChatHeader from "./ChatHeader.svelte";
  import MessageList from "./MessageList.svelte";
  import MessageInput from "./MessageInput.svelte";

  provideStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

<ChatHeader />
<MessageList />
<MessageInput />
```

```svelte
<!-- MessageList.svelte -->
<script lang="ts">
  import { getStream } from "@langchain/svelte";

  const stream = getStream();
</script>

{#each stream.messages as msg (msg.id)}
  <div>{msg.content}</div>
{/each}
```

```svelte
<!-- MessageInput.svelte -->
<script lang="ts">
  import { getStream } from "@langchain/svelte";

  const stream = getStream();
  let input = $state("");

  function send() {
    stream.submit({ messages: [{ type: "human", content: input }] });
    input = "";
  }
</script>

<form onsubmit={send}>
  <textarea bind:value={input}></textarea>
  <button disabled={stream.isLoading} type="submit">Send</button>
</form>
```

```svelte
<!-- ChatHeader.svelte -->
<script lang="ts">
  import { getStream } from "@langchain/svelte";

  const stream = getStream();
</script>

<header>
  <h1>Chat</h1>
  {#if stream.isLoading}
    <span>Thinking...</span>
  {/if}
  {#if stream.error}
    <span>Error occurred</span>
  {/if}
</header>
```

### Multiple Agents

Nest `provideStream` calls for multi-agent scenarios — Svelte's context scoping ensures each subtree gets its own stream:

```svelte
<!-- ResearchPanel.svelte -->
<script lang="ts">
  import { provideStream } from "@langchain/svelte";
  provideStream({ assistantId: "researcher", apiUrl: "http://localhost:2024" });
</script>

<MessageList />
<MessageInput />
```

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
