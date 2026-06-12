---
"@langchain/langgraph-sdk": patch
---

Allow custom `AgentServerAdapter`s to be late-bound and re-bound to a thread. Adapters can now implement an optional `setThreadId(threadId)`, which `client.threads.stream(threadId, { transport })` calls when binding the active thread — including the lazily-minted id from the first `submit()` on a `threadId: null` controller. The built-in `ProtocolSseTransportAdapter`, `ProtocolWebSocketTransportAdapter`, and `HttpAgentServerAdapter` implement it: `threadId` is now optional at construction, request URLs derive from the currently-bound thread, and `paths` entries may be functions of the thread id (`(threadId) => string`). This lets a single custom transport back a lazy thread-creation flow instead of being pinned to one thread at construction.
