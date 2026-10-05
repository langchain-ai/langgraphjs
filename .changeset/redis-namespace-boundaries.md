---
"@langchain/langgraph-checkpoint-redis": patch
---

Keep Redis store namespaces apart. A namespace's documents were found with a text search over their joined labels, which ignores order, case and punctuation, so `["tenant", "a"]` also matched `["a", "tenant"]`, `["tenant", "A"]` and `["tenant", "a-b"]`: `get()` could return another namespace's document, and `put()` and `delete()` could replace or delete it.

Each document's namespace is now compared exactly before it is returned, replaced or deleted. Reads through a label containing `.` return nothing, since `["a.b"]` joins to the same prefix as `["a", "b"]` and `put()` rejects such labels; `search([""])` returns nothing rather than every namespace. Vector search now narrows by every word of the namespace, as plain search does, rather than by its first word only; if Redis rejects that query or it matches nothing, as for a label like `CORP\alice`, it runs the earlier one. The index, stored documents and key matching are unchanged.

Other namespaces' documents are removed from `search()` results after the page is read, so a page can hold fewer than `limit` items, or none, while later pages still hold the namespace's own documents. Those places used to hold the other namespaces' documents.

A lookup checks up to 100 documents with the key whose namespaces hold the same words, such as the same labels in another case or order. Behind more of them, `get()` can return `null`, `put()` can write a second copy of the document and `delete()` can leave it, where earlier versions acted on another namespace's document. If Redis fails after a lookup's first search, `put()` and `delete()` now throw rather than writing a second copy or doing nothing.

Every process that writes to the store must be upgraded: an older version can still replace or delete another namespace's documents.
