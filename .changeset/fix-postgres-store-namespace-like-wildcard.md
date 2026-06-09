---
"@langchain/langgraph-checkpoint-postgres": patch
---

fix: reject SQL `LIKE` wildcards (`%`, `_`) and the backslash escape character in `PostgresStore` namespace labels. `BaseStore.search()` matches namespaces via `namespace_path LIKE ${prefix}%`, and these characters in caller-supplied namespace labels are interpreted as wildcards by Postgres even through a bound parameter — letting a namespace prefix of `["%"]` match every namespace in the store across tenants. `validateNamespace` now throws for these characters at all `search` / `get` / `put` entrypoints, keeping store-wide consistency. CWE-1336.
