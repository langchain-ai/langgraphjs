# Angular SDK docs

This folder contains guides for using `@langchain/angular` to build
LangGraph-powered Angular applications. The docs cover the main stream API,
Angular dependency injection patterns, selectors, transports, and common
interactive agent workflows.

## Core usage

- [`inject-stream.md`](./inject-stream.md) explains the primary `injectStream`
  API, including options, return values, and lifecycle behavior.
- [`dependency-injection.md`](./dependency-injection.md) covers
  `provideStream`, `injectStream`, stream defaults, and `StreamService`.
- [`type-safety.md`](./type-safety.md) describes agent-brand inference, stream
  aliases, and type helpers.
- [`testing.md`](./testing.md) shows how to test streams, selectors, and
  services.

## Streaming features

- [`selectors.md`](./selectors.md) explains selector targets, scoped messages,
  media selectors, and cleanup behavior.
- [`submission-queue.md`](./submission-queue.md) covers queued submissions,
  multitask strategies, and thread swaps.
- [`interrupts.md`](./interrupts.md) shows how to read and resume interrupts.
- [`headless-tools.md`](./headless-tools.md) covers tool handlers and lifecycle
  events that run outside the visible UI.

## Agent workflows

- [`branching.md`](./branching.md) explains how to fork from a message using
  checkpoint IDs.
- [`subagents-subgraphs.md`](./subagents-subgraphs.md) covers subagent and
  subgraph discovery, rendering, and namespace targeting.

## Connectivity and migration

- [`transports.md`](./transports.md) compares the built-in LangGraph Platform
  transports and custom adapters.
- [`custom-transport.md`](./custom-transport.md) is the detailed guide for
  implementing custom transport layers.
- [`v1-migration.md`](./v1-migration.md) explains how to migrate from earlier
  Angular SDK APIs to v1.
