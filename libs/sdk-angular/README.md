# @langchain/angular

Angular SDK for building AI-powered applications with [Deep Agents](https://docs.langchain.com/oss/javascript/deepagents/overview), [LangChain](https://docs.langchain.com/oss/javascript/langchain/overview) and [LangGraph](https://docs.langchain.com/oss/javascript/langgraph/overview).

The package ships a Signals-first API built on top of the v2 streaming
protocol. `injectStream` returns a small, always-on root handle
(`values`, `messages`, `isLoading`, `error`, …) and pushes anything
namespaced (subagents, subgraphs, media, submission queue, per-message
metadata) behind **ref-counted `inject*` selectors** so components
only pay for data they actually consume.

> **Upgrading from `0.x`?** See [`docs/v1-migration.md`](./docs/v1-migration.md)
> for the complete matrix of option, return-shape, and transport
> changes.

## Installation

```bash
npm install @langchain/angular @langchain/core
```

**Peer dependencies:** `@angular/core` (^18.0.0 – ^21.0.0),
`@langchain/core` (^1.1.27).

## Quick start

```typescript
import { Component } from "@angular/core";
import { injectStream } from "@langchain/angular";

@Component({
  standalone: true,
  template: `
    <div>
      @for (msg of stream.messages(); track msg.id ?? $index) {
        <div>{{ str(msg.content) }}</div>
      }

      <button
        [disabled]="stream.isLoading()"
        (click)="onSubmit()"
      >
        Send
      </button>
    </div>
  `,
})
export class ChatComponent {
  readonly stream = injectStream({
    assistantId: "agent",
    apiUrl: "http://localhost:2024",
  });

  str(v: unknown) {
    return typeof v === "string" ? v : JSON.stringify(v);
  }

  onSubmit() {
    void this.stream.submit({
      messages: [{ type: "human", content: "Hello!" }],
    });
  }
}
```

`injectStream` must be called from an **Angular injection context** —
the host's `DestroyRef` owns the stream, so navigating away destroys
the controller automatically.

## Features at a glance

- **Signals everywhere.** Messages, values, tool calls, interrupts,
  loading/error state — all Angular `Signal<T>`s you call as
  functions in templates.
- **One call, two transports.** Same option bag targets either the
  LangGraph Platform (SSE by default, `transport: "websocket"`
  opt-in) or a custom backend through an `AgentServerAdapter`.
- **Ref-counted selectors.** `injectMessages`, `injectValues`,
  `injectToolCalls`, media selectors, submission queue — the first
  consumer opens a subscription, the last one's `DestroyRef` closes
  it. Components pay only for what they render.
- **Human-in-the-loop.** Interrupts are first-class signals; resume
  or fork a specific pending interrupt with one call.
- **Headless tools.** Register browser-side tool implementations;
  the runtime dispatches matching interrupts and auto-resumes with
  the return value.
- **Subagent & subgraph discovery.** Lightweight snapshots at the
  root; scoped content (messages, tool calls, state) via the same
  selectors, targeted at a snapshot or namespace.
- **Forking without history preload.** Per-message metadata +
  `submit({ forkFrom })` replaces the legacy `branch` /
  `fetchStateHistory` trio.
- **DI-native.** `provideStream` for subtree sharing,
  `provideStreamDefaults` for app-wide config, `StreamService` for
  class-based wrappers.
- **Typed end-to-end.** Pass `typeof agent` as the first generic —
  state, tool args, and per-subagent state flow through to every
  selector.

## Public stream types

Use `StreamApi<T>` when you need to name the return type of
`injectStream`, `useStream`, `provideStream`, or `StreamService` in
Angular code. It is the Angular-facing alias for the Signals-first
handle.

`UseStreamResult<T>` is also exported as a React-compatible alias for
the same shape. Prefer it only in shared utilities that are designed to
accept stream handles from multiple framework packages.

## Documentation

In-depth guides live under [`docs/`](./docs):

- [`inject-stream.md`](./docs/inject-stream.md) — options + return-shape reference
- [`transports.md`](./docs/transports.md) — SSE, WebSocket, and custom `AgentServerAdapter`
- [`custom-transport.md`](./docs/custom-transport.md) — implementing `AgentServerAdapter` against your own backend, with a worked walkthrough of [`examples/ui-react-transport`](../../examples/ui-react-transport)
- [`selectors.md`](./docs/selectors.md) — scoped reads (`injectMessages`, `injectValues`, media, channels, …)
- [`interrupts.md`](./docs/interrupts.md) — handling and responding to interrupts
- [`branching.md`](./docs/branching.md) — forking via `injectMessageMetadata` + `submit({ forkFrom })`
- [`submission-queue.md`](./docs/submission-queue.md) — `injectSubmissionQueue` and `multitaskStrategy: "enqueue"`
- [`headless-tools.md`](./docs/headless-tools.md) — browser-side tool implementations
- [`subagents-subgraphs.md`](./docs/subagents-subgraphs.md) — discovery snapshots and scoped content
- [`dependency-injection.md`](./docs/dependency-injection.md) — `provideStream`, `provideStreamDefaults`, `StreamService`
- [`type-safety.md`](./docs/type-safety.md) — generics, agent inference, and public stream aliases
- [`testing.md`](./docs/testing.md) — `STREAM_INSTANCE` fakes and service overrides
- [`v1-migration.md`](./docs/v1-migration.md) — migrating from `0.x`

## Playground

For complete end-to-end examples, visit the
[LangChain UI Playground](https://docs.langchain.com/playground).

## License

MIT
