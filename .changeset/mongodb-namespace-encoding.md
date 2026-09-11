---
"@langchain/langgraph-checkpoint-mongodb": major
---

Use unambiguous namespace keys and vector-filter prefixes to prevent slash-containing labels from aliasing other namespaces. Treat namespace listing labels as literal aggregation values. Existing stores require the explicit migrateNamespaceEncoding maintenance operation before startup; vector search uses a new namespace_v2 index.
