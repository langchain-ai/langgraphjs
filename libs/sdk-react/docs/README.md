# React SDK docs

This folder contains guides for using `@langchain/react` to build
LangGraph-powered React applications. The docs cover the core stream hooks,
context sharing, selectors, transports, and interactive agent patterns such as
interrupts, media, and subagents.

## Core usage

- [`use-stream.md`](./use-stream.md) explains the primary `useStream` hook,
  including options, return values, submissions, stopping, and hydration.
- [`context.md`](./context.md) covers `StreamProvider`, `useStreamContext`,
  type inference, nested providers, and custom adapters.
- [`suspense.md`](./suspense.md) describes `useSuspenseStream` and how it
  differs from `useStream`.
- [`type-safety.md`](./type-safety.md) explains agent-brand inference, custom
  state types, stream prop drilling, and helper types.

## Streaming features

- [`selectors.md`](./selectors.md) covers companion selector hooks for reading
  root or scoped stream data.
- [`submission-queue.md`](./submission-queue.md) explains multitask strategies,
  queued runs, cancellation, and thread switches.
- [`interrupts.md`](./interrupts.md) shows how to read, resume, and respond to
  interrupts, including headless tools.
- [`multimodal.md`](./multimodal.md) covers media handles, media hooks, and
  audio/video helpers.

## Agent workflows

- [`fork-from-checkpoint.md`](./fork-from-checkpoint.md) explains editing or
  retrying from a checkpoint.
- [`subagents.md`](./subagents.md) covers subagent discovery snapshots,
  rendering subagent content, and subgraphs.

## Connectivity

- [`transports.md`](./transports.md) compares built-in SSE, WebSocket,
  header-based auth, and custom adapters.
- [`custom-transport.md`](./custom-transport.md) is the detailed guide for
  implementing custom transport layers.
