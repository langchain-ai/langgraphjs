---
"@langchain/svelte": major
---

Add the Svelte event streaming integration.

Svelte applications can now use the shared event streaming runtime through
`useStream`, `useProjection`, context helpers, and selector runes for messages,
values, tool calls, custom channels, extensions, media, message metadata, and
submission queues. The integration supports thread-scoped runs, reattachment,
interrupts, WebSocket and SSE/custom transports, headless tools, subgraphs,
subagents, typed stream extensions, and strongly typed state/tool-call
inference.

This release also adds Svelte media helpers, including `useMediaURL`,
`useAudioPlayer`, and `useVideoPlayer`, plus selectors for audio, images,
video, and files. Shared transport, media, protocol event, message metadata,
and discovery types are exported from the package so Svelte components can
compose streaming interfaces without deep imports.

The package now includes focused documentation and tests for context, custom
transports, selectors, interrupts, hydration, submission queues,
subscriptions, headless tools, subagents, type safety, and migration from the
previous streaming API.
