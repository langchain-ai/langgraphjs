# Vue SDK docs

This folder contains guides for using `@langchain/vue` to build
LangGraph-powered Vue applications. The docs cover the stream composables,
context sharing, selectors, transports, testing, and advanced agent workflows.

## Core usage

- [`api-reference.md`](./api-reference.md) documents `useStream` options,
  return values, and related APIs.
- [`sharing-streams.md`](./sharing-streams.md) covers `provideStream`,
  `useStreamContext`, app-level defaults, and multi-agent layouts.
- [`suspense.md`](./suspense.md) explains suspense-style hydration and
  `hydrationPromise`.
- [`type-safety.md`](./type-safety.md) explains agent-brand inference, custom
  state shapes, stream prop drilling, and helper types.
- [`testing.md`](./testing.md) shows how to test with provided streams.

## Streaming features

- [`selectors.md`](./selectors.md) covers selector composables, target
  arguments, examples, and cleanup behavior.
- [`submission-queue.md`](./submission-queue.md) explains queued submissions and
  thread switching.
- [`interrupts.md`](./interrupts.md) shows how to handle interrupts, resume a
  specific interrupt, stop runs, and use headless tools.
- [`multimodal.md`](./multimodal.md) covers multimodal media selectors, helper
  APIs, examples, and subagent scoping.

## Agent workflows

- [`forking.md`](./forking.md) explains forking from a message for branching
  workflows.
- [`subagents.md`](./subagents.md) covers subagent and subgraph rendering,
  listing, and discovery.

## Connectivity and migration

- [`transports.md`](./transports.md) compares built-in SSE, WebSocket, and
  custom adapter options.
- [`custom-transport.md`](./custom-transport.md) is the detailed guide for
  implementing custom transport layers.
- [`v1-migration.md`](./v1-migration.md) explains how to migrate to
  `@langchain/vue` v1.
