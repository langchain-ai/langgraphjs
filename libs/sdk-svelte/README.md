# @langchain/svelte

Svelte 5 SDK for [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

`useStream` binds a LangGraph agent into a Svelte 5 component. Reactive fields are exposed as getters on a stable handle (`stream.messages`, `stream.isLoading`, …) so templates and `$derived` expressions track updates automatically — no stores, no `$` prefix, no destructuring.

## Installation

```bash
npm install @langchain/svelte @langchain/core
```

**Peer dependencies:** `svelte` ^5.0.0, `@langchain/core` ^1.0.1

## Quick start

```svelte
<script lang="ts">
  import { useStream } from "@langchain/svelte";

  const stream = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });
</script>

{#each stream.messages as msg (msg.id)}
  <div>{msg.content}</div>
{/each}

<button
  disabled={stream.isLoading}
  onclick={() =>
    stream.submit({ messages: [{ type: "human", content: "Hello!" }] })}
>
  Send
</button>
```

> **Note:** Access fields through the live `stream` handle. Destructuring (`const { messages } = stream`) freezes the values at that moment — use `stream.messages` in templates instead.

## Highlights

- **v2-native streaming protocol.** Session-based transport with automatic re-attach on remount; no more `reconnectOnMount` / `joinStream` dance.
- **Always-on root projections.** `values`, `messages`, `toolCalls`, and `interrupts` are reactive at the root with zero extra subscription cost.
- **Selector composables for scoped data.** Per-subagent / per-subgraph messages, tool calls, and media stream only when a component actually mounts the matching composable, and release on unmount.
- **Discriminated option bag.** The hosted Agent Server path and the custom-adapter path are two arms of a single typed union — mixing them is a compile-time error.
- **Reactive `threadId`.** Pass `threadId: () => active` to drive in-place thread swaps without remounting.
- **Agent-brand type inference.** `useStream<typeof agent>()` unwraps state, tool calls, and subagent state maps from an agent brand.
- **Multimodal media streams.** Built-in assembly for audio, images, video, and files — plus opinionated playback helpers.
- **Headless tools.** Register local tool implementations that auto-resolve server-emitted tool-call interrupts without a round-trip through the UI.

## Documentation

In-depth guides live in [`docs/`](./docs/):

- [`useStream` — options, return shape, reactive `threadId`](./docs/use-stream.md)
- [Selector composables (`useMessages`, `useToolCalls`, `useValues`, …)](./docs/selector-composables.md)
- [Interrupts, `respond()`, `stop()`, `hydrationPromise`](./docs/interrupts.md)
- [Submission queue](./docs/submission-queue.md)
- [Stream context (`provideStream` / `getStream`)](./docs/stream-context.md)
- [Headless tools](./docs/headless-tools.md)
- [Custom transport (`AgentServerAdapter`, `HttpAgentServerAdapter`)](./docs/custom-transport.md)
- [Media (images, audio, video, files) & playback helpers](./docs/media.md)
- [Type safety](./docs/type-safety.md)

## Migrating from v0

`@langchain/svelte` **v1** targets the v2 streaming protocol. The `useStream` import stays the same, but the option bag, return shape, and how you subscribe to scoped data all change. Most chat apps migrate in well under an hour — the full guide with line-by-line diffs lives in [`docs/v1-migration.md`](./docs/v1-migration.md).

## Playground

For full end-to-end examples, see the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
