---
"@langchain/angular": major
---

Add the Angular event streaming integration.

Angular applications can now build on the shared event streaming runtime with
`useStream`, `injectStream`, `StreamService`, `provideStream`,
`provideStreamDefaults`, `injectProjection`, and selector helpers for messages,
values, tool calls, custom channels, extensions, media, message metadata, and
submission queues. The integration supports thread switching, run submission,
reattachment, interrupts, WebSocket and SSE/custom transports, headless tools,
subgraphs, subagents, and typed event projections.

This release also adds Angular-specific media helpers, including
`injectMediaUrl` and selectors for audio, images, video, and files. The package
now exports the shared stream, media, transport, headless-tool, and type
inference types needed to compose strongly typed streaming UIs.

The documentation has been refreshed with guides for dependency injection,
`injectStream`, selectors, transports, custom transports, interrupts,
submission queues, headless tools, subagents/subgraphs, type safety, testing,
and migration from the previous SDK surface.
