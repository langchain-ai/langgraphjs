---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

`useStream`'s `"enqueue"` multitask strategy can now be backed by real, durable server-side runs instead of an in-memory client-only queue.

Pass `queue: "server"` to opt in; it defaults to `"local"`, so existing usage is unaffected. `"server"` requires the backend behind `apiUrl` to implement the Runs REST endpoints (`POST`/`GET /threads/{thread_id}/runs`, `POST /threads/{thread_id}/runs/{run_id}/cancel`), not just streaming/commands. Queued submissions then persist across reloads and are visible to other sessions, and `cancelQueued`/`clearQueue` cancel them server-side too.

Not supported with a custom `AgentServerAdapter` transport — `queue` only applies to the built-in transport.
