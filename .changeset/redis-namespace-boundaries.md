---
"@langchain/langgraph-checkpoint-redis": patch
---

Keep Redis store namespaces apart. A namespace's documents were found with a text search over their joined labels, which ignores order, case and punctuation, so `["tenant", "a"]` also matched `["a", "tenant"]`, `["tenant", "A"]` and `["tenant", "a-b"]`: `get()` could return another namespace's document, and `put()` and `delete()` could replace or delete it.

Each document's namespace is now compared exactly before it is returned, replaced or deleted. Reads through an empty namespace, or a label that is empty or contains `.`, return nothing, since no document can be stored under one. Keys are compared exactly too, so `"K"` and `"k"` are now different keys. Vector search now narrows by every word of the namespace, as plain search does, rather than by its first word only. The index and stored documents are unchanged.

`get()`, `put()` and `delete()` now throw if more than 10,000 documents may belong to the namespace, rather than acting on the wrong document. Every process that writes to the store must be upgraded: an older version can still replace or delete another namespace's documents.
