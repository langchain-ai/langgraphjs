---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

`useStream`'s `"enqueue"` multitask strategy can now be backed by real, durable server-side runs instead of an in-memory client-only queue.

Pass `serverQueue: true` to back it with the built-in transport's own credentials, or set `serverQueue` directly on a custom `AgentServerAdapter`. Queued submissions become server-accepted runs immediately (`multitaskStrategy: "enqueue"`), are hydrated from the Runs API on load, and are cancelled server-side through `cancelQueued`/`clearQueue`.

Omit `serverQueue` and `"enqueue"` behaves exactly as it does today. This is fully opt-in and non-breaking.
