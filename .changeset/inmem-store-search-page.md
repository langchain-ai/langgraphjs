---
"@langchain/langgraph-checkpoint": patch
---

`InMemoryStore.search` stops collecting matches at `offset + limit` when there is no query embedding, and copies only the returned page. A first page is about 20x faster on a 1,000-item namespace, and a search over a namespace with hundreds of thousands of items no longer throws `RangeError`.
