---
"@langchain/langgraph-checkpoint-redis": patch
---

Match Redis store namespace prefixes at segment boundaries. Scoped reads, writes and deletes previously accepted any namespace RediSearch considered similar, so `tenant.a` could resolve a document under `tenant.A` and overwrite or delete it. Indexed queries now only narrow the candidate set; the exact namespace is confirmed on every document before it is returned or mutated, and search applies that check before pagination and vector selection.

No index migration, schema change, or additional Redis permissions are required. Upgrading the package is the complete fix.

`setup()` no longer decides whether an `FT.CREATE` failure is fatal by matching on the server's error text. It now accepts any failure the index survives -- a concurrent creation, or an ACL that grants reads but not creates -- and reports the original error as `cause` when the index really is unusable.

Three failures that were previously swallowed now surface. `get()` and `search()` threw away a missing index and returned `null` and `[]`; they now throw and name `await store.setup()`, because an empty result and an absent index are different answers. `put()` ignored a failed lookup of the document it was about to replace and wrote anyway, which could leave the old document in place beside the new one; a failed lookup now aborts the write it was guarding.

`FilterBuilder.buildRedisSearchQuery` has been removed. It was exported for tests, called from nowhere else, and built queries with the unanchored matching this release fixes.
