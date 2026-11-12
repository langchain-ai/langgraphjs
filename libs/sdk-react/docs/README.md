# `@langchain/react` docs

Guides for building React apps on LangGraph agents with `@langchain/react`.

## Start here

- [`use-stream.md`](./use-stream.md): the `useStream` hook, its options and return values, and `submit`, `stop`, `respond` and `hydrate`.
- [`selectors.md`](./selectors.md): the selector hooks, for a subagent's or a subgraph's view, message metadata, the queue and raw events.
- [`v2-migration.md`](./v2-migration.md): upgrading from `@langchain/react` 1.x.

## Features

- [`interrupts.md`](./interrupts.md): reading and answering interrupts, and headless tools.
- [`submission-queue.md`](./submission-queue.md): messages sent during a run, multitask strategies and `useSubmissionQueue`.
- [`subagents.md`](./subagents.md): subagent and subgraph snapshots, and showing what one says.
- [`fork-from-checkpoint.md`](./fork-from-checkpoint.md): editing a message or retrying an answer.
- [`suspense.md`](./suspense.md): `useSuspenseStream`.
- [`context.md`](./context.md): `StreamProvider` and `useStreamContext`.
- [`type-safety.md`](./type-safety.md): types from your agent, and the type helpers.

## Connecting

- [`transports.md`](./transports.md): the Agent Server, headers and auth.
- [`custom-transport.md`](./custom-transport.md): pointing the hooks at your own backend.
