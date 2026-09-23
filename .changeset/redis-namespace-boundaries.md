---
"@langchain/langgraph-checkpoint-redis": patch
---

Keep Redis store namespaces apart. A namespace's documents were found with a text search over their joined labels, which ignores order, case and punctuation, so `["tenant", "a"]` also matched `["a", "tenant"]`, `["tenant", "A"]` and `["tenant", "a-b"]`: `get()` could return another namespace's document, and `put()` and `delete()` could replace or delete it. Labels were also inserted into the query unescaped.

Each document's namespace is now compared exactly before it is returned, replaced or deleted, and reads through a label that is empty or contains `.` return nothing, since no document can be stored under one. `setup()` also adds two tag fields over `prefix` to the existing indexes (`FT.ALTER`; no document is rewritten): `prefix_exact`, the whole namespace, and `prefix_labels`, each label. Once Redis has indexed them, `get()`, `put()` and `delete()` look documents up by the exact namespace and `search()` by its labels, with every value passed as a query parameter rather than written into the query. Until then, or if `setup()` is not called, the fields cannot be added, or the connection is a cluster, queries keep the earlier text search.
