---
"@langchain/langgraph-checkpoint-redis": patch
---

Keep Redis store namespaces apart. A namespace's documents were found with a text search over their joined labels, which ignores order, case and punctuation, so `["tenant", "a"]` also matched `["a", "tenant"]`, `["tenant", "A"]` and `["tenant", "a-b"]`: `get()` could return another namespace's document, and `put()` and `delete()` could replace or delete it. The query now only narrows the candidates, and each document's namespace is compared exactly before it is returned, replaced or deleted. Reads through a label that contains `.` return nothing, since no document can be stored under one.
