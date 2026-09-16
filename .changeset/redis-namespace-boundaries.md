---
"@langchain/langgraph-checkpoint-redis": patch
---

Match Redis store namespace prefixes at segment boundaries. Scoped reads, writes and deletes previously accepted any namespace RediSearch considered similar, so `tenant.a` could resolve a document under `tenant.A` and overwrite or delete it. Indexed queries now only narrow the candidate set; the exact namespace is confirmed on every document before it is returned or mutated, and search applies that check before pagination and vector selection.

No index migration, schema change, or additional Redis permissions are required. Upgrading the package is the complete fix.
