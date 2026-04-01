---
"@langchain/vue": major
---

Add the Vue event streaming integration.

Vue applications can now use the shared event streaming runtime through
`useStream`, `useProjection`, `provideStream`, `useStreamContext`, and
selector composables for messages, values, tool calls, custom channels,
extensions, media, message metadata, and submission queues. The integration
supports thread-scoped runs, reattachment, interrupts, WebSocket and
SSE/custom transports, headless tools, subgraphs, subagents, typed stream
extensions, and strongly typed state/tool-call inference.

This release also adds Vue media helpers, including `useMediaURL`,
`useAudioPlayer`, and `useVideoPlayer`, plus selectors for audio, images,
video, and files. Shared transport, media, protocol event, message metadata,
and discovery types are exported from the package so Vue components can build
rich streaming UIs without deep imports.

The package documentation and tests now cover API usage, custom transports,
forking, interrupts, multimodal streaming, selectors, shared streams,
subagents, suspense, submission queues, transports, type safety, and migration
from the previous streaming API.
