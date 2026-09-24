---
"@langchain/langgraph-checkpoint-redis": patch
---

Keep Redis store namespaces apart. A namespace's documents were found with a text search over their joined labels, which ignores order, case and punctuation, so `["tenant", "a"]` also matched `["a", "tenant"]`, `["tenant", "A"]` and `["tenant", "a-b"]`: `get()` could return another namespace's document, and `put()` and `delete()` could replace or delete it. Labels were also inserted into the query unescaped.

Each document's namespace is now compared exactly before it is returned, replaced or deleted, and reads through a label that is empty or contains `.` return nothing, since no document can be stored under one. Vector search now narrows by every word of the namespace, as plain search does, rather than by its first word only, so it no longer comes back empty once other namespaces' neighbours are removed. The index and stored documents are unchanged.
