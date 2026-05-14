---
"@langchain/langgraph-sdk": patch
---

Normalize `BaseMessage` instances to canonical `{type, content, ...}` dicts in client request bodies (HTTP `json` payloads and v2 transport command bodies). Previously the default `JSON.stringify` invoked `BaseMessage.toJSON()` and emitted the `{lc:1, type:"constructor", id, kwargs}` envelope, which the `langgraph-api` Python server can no longer revive (the `langchain_core.load.load()` deserializer was removed from the request path as a CWE-502 mitigation). Plain-dict callers are unaffected — the `isBaseMessage` typeguard rejects POJOs and they pass through unchanged.
