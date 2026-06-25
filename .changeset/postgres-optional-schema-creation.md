---
"@langchain/langgraph-checkpoint-postgres": minor
---

Add a `createSchema` option to `PostgresSaver` and `PostgresStore` for use alongside a custom `schema`. When `true` (the default), `setup()` runs `CREATE SCHEMA IF NOT EXISTS` as before. When `false`, `setup()` instead verifies the schema already exists and throws if it does not, without attempting to create it — useful for least-privilege database roles that are not permitted to create schemas. Table migrations still run either way.

Add an `ensureTables` option to `PostgresSaver` (matching `PostgresStore`). When `true` (the default), the first database operation runs `setup()` automatically, so calling `setup()` explicitly is now optional. When `false`, no auto-setup occurs and `setup()` must be called explicitly before use. This is backward-compatible: explicit `setup()` remains idempotent.

Fix a first-operation concurrency race in both `PostgresSaver` and `PostgresStore`: on a fresh instance, two operations starting concurrently could each trigger a full migration run, risking duplicate migration execution. `setup()` is now single-flighted so concurrent callers share one run, and a failed run is not cached (a corrected condition can retry).
