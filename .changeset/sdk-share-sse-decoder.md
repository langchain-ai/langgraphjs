---
"@langchain/langgraph-sdk": patch
---

Deduplicate the client stream transports: the protocol transport now shares the SSE decoder and `IterableReadableStream` helpers with the legacy transport instead of carrying its own copies. Removes the redundant `transport/decoder.ts` and `transport/stream.ts` shims (and a dead `StreamPart` re-export), importing the shared utilities from `utils/sse.ts` directly. No public API or behavior change.
