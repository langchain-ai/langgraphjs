# Svelte SDK docs

This folder contains guides for using `@langchain/svelte` to build
LangGraph-powered Svelte applications. The docs cover the main stream
composable, stream context, selectors, custom transports, and interactive agent
workflows.

## Core usage

- [`use-stream.md`](./use-stream.md) explains the primary `useStream`
  composable, including options, return shape, and reactive `threadId` values.
- [`stream-context.md`](./stream-context.md) covers providing and reading a
  stream through Svelte context.
- [`type-safety.md`](./type-safety.md) explains agent-brand inference, custom
  state types, typed stream handles, and helper types.
- [`v1-migration.md`](./v1-migration.md) explains how to migrate from
  `@langchain/svelte` v0 to v1.

## Streaming features

- [`selector-composables.md`](./selector-composables.md) covers selector
  composables, per-subagent views, per-message metadata, and raw event access.
- [`submission-queue.md`](./submission-queue.md) explains the submission queue
  exposed by the stream.
- [`interrupts.md`](./interrupts.md) shows how to handle targeted interrupts,
  stop runs, and use `hydrationPromise`.
- [`media.md`](./media.md) covers media URLs and audio/video helpers.

## Agent workflows and connectivity

- [`headless-tools.md`](./headless-tools.md) covers tool implementations and
  lifecycle events for headless tools.
- [`custom-transport.md`](./custom-transport.md) is the detailed guide for
  implementing custom transport layers in Svelte apps.
