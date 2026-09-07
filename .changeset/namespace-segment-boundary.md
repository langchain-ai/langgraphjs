---
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-checkpoint-postgres": patch
---

fix(checkpoint): stop `search()` namespace prefix matching at segment boundaries (CVE-2026-71433 port)

`InMemoryStore.search(["tenant","acme"])` no longer returns sibling `["tenant","acme-corp"]` items. Postgres `LIKE prefix%` is now exact-or-descendant (`= path OR LIKE path:%`). Namespace labels may not contain `:`. Empty prefix still means "search everything" on InMemoryStore. Closes #2721.
