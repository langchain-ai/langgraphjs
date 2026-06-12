# @langchain/react

React SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

`@langchain/react` v1 ships a v2-native `useStream` hook together with a small family of companion selector hooks. The root hook gives you always-on access to thread state, messages, tool calls, and interrupts; the selector hooks open ref-counted subscriptions for the things that aren't needed on every view (per-subagent messages, media streams, submission queue, message metadata, raw channels, …).

## Highlights

- **v2-native streaming protocol.** Session-based transport with automatic re-attach on remount; no more `reconnectOnMount` / `joinStream` dance.
- **Selector-based subscriptions.** Namespaced data (subagents, subgraphs, media) streams only when a component actually mounts the matching selector hook, and releases on unmount.
- **Always-on root projections.** `values`, `messages`, `toolCalls`, and `interrupts` are live at the root with zero per-subscription cost.
- **Agent-brand type inference.** `useStream<typeof agent>()` unwraps state, tool calls, and subagent state maps from an agent brand.
- **Discriminated options.** The hosted Agent Server path and the custom-adapter path are two arms of a single typed union — mixing them is a compile-time error.
- **Multimodal media streams.** Built-in assembly for audio, images, video, and files.
- **Suspense integration.** `useSuspenseStream` hands the initial hydration phase to `<Suspense>` and non-streaming errors to Error Boundaries.

## Installation

```bash
npm install @langchain/react @langchain/core
```

**Peer dependencies:** `react` (^18 || ^19), `@langchain/core` (^1.1.27).

## Quick Start

```tsx
import { useStream } from "@langchain/react";

function Chat() {
  const { messages, submit, isLoading } = useStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  return (
    <div>
      {messages.map((msg, i) => (
        <div key={msg.id ?? i}>{String(msg.content)}</div>
      ))}

      <button
        disabled={isLoading}
        onClick={() =>
          void submit({
            messages: [{ type: "human", content: "Hello!" }],
          })
        }
      >
        Send
      </button>
    </div>
  );
}
```

## Mental model

`@langchain/react` v1 splits the surface into two layers:

1. **Root hook (`useStream`).** Owns the thread lifecycle, the transport, and a handful of always-on projections (`values`, `messages`, `toolCalls`, `interrupts`, `error`, `isLoading`, discovery maps). Mount it once per thread.
2. **Companion selector hooks.** Each one opens a ref-counted subscription when the first component mounts it and releases it when the last consumer unmounts. Use them for anything scoped to a namespace, a subagent / subgraph, a specific message, a specific extension channel, or a media stream.

```tsx
import {
  useStream,
  useMessages,
  useToolCalls,
  useSubmissionQueue,
} from "@langchain/react";

function Chat() {
  const stream = useStream({ assistantId: "agent", apiUrl: "/api" });

  // Root: free reads, no new subscription.
  const messages = useMessages(stream); // same as stream.messages

  // Scoped: opens a namespaced subscription on mount.
  const queue = useSubmissionQueue(stream);
}
```

## Documentation

Detailed guides live in [`./docs`](./docs/). Start with the two files most apps need first:

- **[`useStream`](./docs/use-stream.md)** — options, return shape, `submit()`, `stop()`, `respond()`, `hydrationPromise`.
- **[Companion selector hooks](./docs/selectors.md)** — `useValues`, `useMessages`, `useToolCalls`, `useMessageMetadata`, `useChannel`, `useExtension`, and friends.

Feature-specific guides:

- **[Transports](./docs/transports.md)** — SSE, WebSocket, `HttpAgentServerAdapter`, custom `AgentServerAdapter`.
- **[Custom transports](./docs/custom-transport.md)** — implementing `AgentServerAdapter` against your own backend, with a worked walkthrough of [`examples/ui-react-transport`](../../examples/ui-react-transport).
- **[Interrupts & headless tools](./docs/interrupts.md)** — pausing runs, `respond()`, `tools` + `onTool`.
- **[Fork / edit from a checkpoint](./docs/fork-from-checkpoint.md)** — `useMessageMetadata` + `submit({ forkFrom })`.
- **[Submission queue](./docs/submission-queue.md)** — `multitaskStrategy: "enqueue"` + `useSubmissionQueue`.
- **[Subagents & subgraphs](./docs/subagents.md)** — discovery maps, scoped selector subscriptions.
- **[Multimodal media](./docs/multimodal.md)** — `useAudio` / `useImages` / `useVideo` / `useFiles`, `useMediaURL`, players.
- **[`useSuspenseStream`](./docs/suspense.md)** — Suspense + Error Boundary integration.
- **[`StreamProvider` / `useStreamContext`](./docs/context.md)** — share one stream across a subtree.
- **[Type safety](./docs/type-safety.md)** — agent-brand inference, prop-drilling, type helpers.

## Migrating from v0 to v1

The `useStream` import name is unchanged, but the return shape, option bag, and protocol semantics all shifted. Most chat apps migrate in well under an hour — the full migration guide with line-by-line diffs lives in [`./docs/v1-migration.md`](./docs/v1-migration.md).

Legacy type aliases (`UseStream`, `UseSuspenseStream`, `UseStreamOptions`, `UseStreamTransport`, `QueueEntry`, `GetToolCallsType`, `SubagentStream`, …) and the legacy `FetchStreamTransport` class are **no longer re-exported** from `@langchain/react`. Apps still on the legacy surface can import directly from `@langchain/langgraph-sdk/ui` during their migration.

## Playground

For complete end-to-end examples with full agentic UIs, visit the [LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
