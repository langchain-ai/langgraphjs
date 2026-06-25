---
"@langchain/langgraph": patch
---

fix(langgraph): drop unused zod-to-json-schema peer dependency

Remove the vestigial `zod-to-json-schema` (and its `peerDependenciesMeta`/dev) declarations. JSON Schema generation now flows through `@langchain/core`'s Zod v3/v4 interop (`toJsonSchema`), so the old `zod-to-json-schema@^3.x` peer (which pins `zod@^3.24.1`) is no longer needed and was the last source of install-time peer conflicts with Zod v4. Closes #1706.
