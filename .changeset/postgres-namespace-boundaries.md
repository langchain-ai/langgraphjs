---
"@langchain/langgraph-checkpoint-postgres": patch
---

Match Postgres store namespace prefixes and suffixes at segment boundaries. Validate namespace listing filters, escape namespace LIKE patterns, and reject colons inside namespace labels to prevent ambiguous paths.

Align namespace listing `*` wildcards with InMemoryStore: match exactly one segment while treating stars embedded in labels literally.
