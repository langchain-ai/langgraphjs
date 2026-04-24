# @langchain/vue

Vue SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

The package ships a Composition-API–first binding built on top of
the v2 streaming protocol. `useStream` returns a small, always-on
root handle (`values`, `messages`, `isLoading`, `error`, …) and
pushes anything namespaced (subagents, subgraphs, media, submission
queue, per-message metadata) behind **ref-counted `use*` selectors**
so components only pay for the data they actually consume.

> **Upgrading from `0.x`?** See [`docs/v1-migration.md`](./docs/v1-migration.md)
> for the complete matrix of option, return-shape, and transport
> changes.

## Highlights

- **v2-native streaming protocol.** Session-based transport with
  automatic re-attach on remount — no `reconnectOnMount` /
  `joinStream` dance.
- **Composition-API first.** Everything is a `ShallowRef` /
  `ComputedRef`, auto-disposed via `onScopeDispose` when the scope
  unmounts.
- **Selector-based subscriptions.** Namespaced data (subagents,
  subgraphs, media) streams only when a component actually mounts
  the matching selector composable, and releases on unmount.
- **Discriminated transports.** Hosted Agent Server and custom
  adapters are two arms of a single typed union — mixing them is a
  compile-time error.
- **Agent-brand type inference.** `useStream<typeof agent>()`
  unwraps state, tool calls, and subagent state maps from an agent
  brand.
- **Multimodal media streams.** Built-in assembly for audio,
  images, video, and files, with ready-to-use `<img>` / `<audio>` /
  `<video>` players.
- **`<Suspense>` friendly.** `hydrationPromise` lets you gate
  `async setup()` on initial hydration.

## Installation

```bash
npm install @langchain/vue @langchain/core
```

**Peer dependencies:** `vue` (^3.4.0), `@langchain/core` (^1.0.1).

## Quick start

```vue
<script setup lang="ts">
import { useStream } from "@langchain/vue";

const stream = useStream({
  assistantId: "agent",
  apiUrl: "http://localhost:2024",
});

function onSubmit() {
  void stream.submit({ messages: [{ type: "human", content: "Hello!" }] });
}
</script>

<template>
  <div>
    <div
      v-for="(msg, i) in stream.messages.value"
      :key="msg.id ?? i"
    >
      {{ typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) }}
    </div>

    <button :disabled="stream.isLoading.value" @click="onSubmit">
      Send
    </button>
  </div>
</template>
```

Reactive fields on the handle are Vue refs (`ShallowRef` /
`ComputedRef`) — read them via `.value` in `<script setup>` or
directly in `<template>` (Vue auto-unwraps refs in templates, so
`stream.messages` and `stream.messages.value` behave the same way
inside the template block).

## Documentation

In-depth guides live in [`docs/`](./docs):

- [API reference](./docs/api-reference.md) — `useStream` options and
  return shape.
- [Selectors](./docs/selectors.md) — ref-counted readers for
  namespaced / scoped data.
- [Transports](./docs/transports.md) — SSE, WebSocket, and custom
  `AgentServerAdapter` implementations.
- [Interrupts & headless tools](./docs/interrupts.md) — pausing a
  run, responding to interrupts, registering browser-side tools.
- [Forking from a message](./docs/forking.md) — edit / retry flows
  with `useMessageMetadata` + `submit({ forkFrom })`.
- [Submission queue](./docs/submission-queue.md) — inspecting and
  cancelling enqueued submits.
- [Subagents & subgraphs](./docs/subagents.md) — rendering
  per-subagent messages, tool calls, and state via scoped selectors.
- [Multimodal media](./docs/multimodal.md) — audio / image / video /
  file streams with built-in players.
- [Sharing a stream](./docs/sharing-streams.md) — `provideStream`,
  `useStreamContext`, and the `LangChainPlugin` app-level defaults.
- [Suspense-style hydration](./docs/suspense.md) — gating
  `async setup()` on `hydrationPromise`.
- [Type safety](./docs/type-safety.md) — brand inference, generics,
  and the exported helper types.
- [Testing](./docs/testing.md) — mounting components with mock
  streams or real dev servers.
- [Migrating from 0.x](./docs/v1-migration.md) — full diff of
  options, return shape, and transport classes.

## Playground

For complete end-to-end examples with full agentic UIs, visit the
[LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
