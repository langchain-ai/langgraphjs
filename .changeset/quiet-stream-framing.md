---
"@langchain/langgraph-sdk": patch
---

Fix SSE multiline JSON framing, colonless fields, stream-leading BOM handling, and empty event ID resets during reconnection. Match Python streaming behavior: empty payloads yield null, events inherit the reconnect cursor, and ID-only/retry-only blocks update internal state without being yielded to callers. Cleared event IDs are exposed as undefined. Pending unnamed data is flushed at EOF, matching Python's existing tolerant EOF behavior.
