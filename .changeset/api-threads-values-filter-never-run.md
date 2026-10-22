---
"@langchain/langgraph-api": patch
---

Fix `threads.search` and `threads.count` in the in-memory/file-system store so that a thread that has never run (no `values` yet) no longer matches every `values` filter. A non-empty `values` filter now excludes such threads; an empty filter still matches all threads.
