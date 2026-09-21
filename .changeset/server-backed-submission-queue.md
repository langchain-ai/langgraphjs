---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

`useStream`'s `"enqueue"` multitask strategy can now be backed by real, durable server-side runs instead of an in-memory client-only queue.

This is derived from the transport, not opted into: the built-in transport is always server-backed (it already carries a `client` with `.runs`). A custom `AgentServerAdapter` opts in by implementing `serverQueue`; omitting it keeps `"enqueue"` as a client-only, in-memory defer. Queued submissions become server-accepted runs immediately (`multitaskStrategy: "enqueue"`), are hydrated from the Runs API on load, and are cancelled server-side through `cancelQueued`/`clearQueue`.

This changes default behavior for the built-in transport: any existing `"enqueue"` usage there now gets durable server-side queueing instead of the previous in-memory-only defer, with no flag to opt back out.
