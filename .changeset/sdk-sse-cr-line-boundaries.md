---
"@langchain/langgraph-sdk": patch
---

Emit CR-terminated SSE lines immediately instead of waiting for another network chunk. Preserve terminal empty lines so a final data-only event is dispatched when a CR-delimited stream closes, while continuing to treat split CRLF pairs as one line ending.
