---
"@langchain/langgraph-sdk": minor
---

Add the framework-agnostic event streaming SDK.

The SDK now includes a thread-focused streaming client built around
`ThreadStream`, `SubscriptionHandle`, message assembly, media assembly, typed
stream extensions, and pluggable protocol transports. Applications can stream
over SSE or WebSocket, provide custom agent-server adapters, subscribe to
values/messages/tools/custom/lifecycle/checkpoint channels, inspect and fork
state, respond to interrupts, and replay or dedupe ordered event streams.

This release also adds the reusable stream runtime used by the React, Vue,
Svelte, and Angular packages: `StreamController`, `StreamStore`,
`ChannelRegistry`, projection factories, subagent/subgraph discovery,
submission queue coordination, message metadata tracking, root message
projection, media projections, and helper types for agent/deep-agent state and
tool-call inference.

The client package has been reorganized into focused modules for assistants,
threads, runs, store, protocol streaming, transports, media, messages, and UI
helpers. New SDK documentation covers configuration, assistants, threads, runs,
store, streaming, transports, extensions, interrupts, messages, media,
subagents, and subgraphs.
