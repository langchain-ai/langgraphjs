---
"@langchain/react": major
---

Add the React event streaming integration.

React applications can now use the shared event streaming runtime through
`useStream`, `useProjection`, `useSuspenseStream`, `StreamProvider`, and
focused selector hooks for messages, values, tool calls, custom channels,
extensions, media, message metadata, and submission queues. The new integration
supports thread-scoped runs, reattachment, interrupts, WebSocket and
SSE/custom transports, headless tools, subgraphs, subagents, typed stream
extensions, and strongly typed state/tool-call inference.

This release also adds media helpers for streaming UI experiences, including
`useMediaURL`, `useAudioPlayer`, and `useVideoPlayer`, plus selectors for
audio, images, video, and files. Shared transport, media, protocol event,
message metadata, and discovery types are exported from the package so React
components can compose richer streaming interfaces without deep imports.

The package documentation and tests have been expanded around custom
transports, selectors, interrupts, multimodal streaming, suspense, submission
queues, headless tools, subagents, type safety, and migration from the previous
streaming API.
