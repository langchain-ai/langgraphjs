---
"@langchain/langgraph-sdk": patch
---

Preserve metadata from v2 message SSE events when constructing frontend message objects, so applications can inspect message provenance and model completion details without parsing raw events.

- Retain namespace, graph node, callback `run_id`, and message-start metadata in `additional_kwargs`, including messages returned by awaiting a `StreamingMessage`.
- Expose finish reasons and provider response metadata in `response_metadata` across message roles, accepting both Python `metadata` and JavaScript `responseMetadata` event fields.
- Populate the standard AI `usage_metadata` field while retaining `additional_kwargs.usage` for compatibility. Preserve earlier usage when a finish event omits it.
- Keep interleaved streams at the same namespace and node separate using callback `run_id`, while retaining fallback behavior for legacy events without run IDs.

These fields describe individual messages and model calls: a finish reason does not identify the final response of a graph turn, and callback run IDs are not necessarily server run IDs. This change does not add an `is_final` marker or persist stream-only metadata into historical checkpoints.
