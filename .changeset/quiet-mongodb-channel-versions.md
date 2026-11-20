---
"@langchain/langgraph-checkpoint-mongodb": minor
---

Store versioned checkpoint channel values once and reconstruct complete state in
getTuple/list, while retaining reads of old full-document rows and full writes
when newVersions is omitted. Preserve namespace/fork isolation, serializer bytes,
TTL retention and thread deletion.

Upgrade all readers before enabling these writes: older savers cannot read the
new reference-based rows. Mixed-version readers and rollback to older readers on
the same collection are unsupported; use a separate checkpoint collection for a
staged rollout. Include its derived `_blobs` collection in backups.
