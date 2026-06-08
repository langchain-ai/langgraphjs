---
"@langchain/langgraph-api": minor
---

Consolidate the protocol session's channel inference, channel-set validation, and namespace prefix matching onto the shared `@langchain/langgraph/stream` helpers instead of maintaining local copies. This removes duplicated logic across `session/index.mts`, `session/namespace.mts`, `session/internal-types.mts`, and `service.mts`.

This also aligns SSE event-sink filtering (`matchesSinkFilter`) with the WebSocket subscription matcher: both now normalize dynamic namespace suffixes (e.g. a `["fetcher"]` namespace filter matches an event emitted under `["fetcher:<uuid>"]`). Previously the SSE path used a stricter exact-segment match.

Because the session now imports `@langchain/langgraph/stream`, the `@langchain/langgraph` peer dependency floor is raised to `^1.3.6` (the first release that ships the `/stream` entrypoint).
