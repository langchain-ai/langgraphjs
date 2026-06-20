---
"@langchain/langgraph-checkpoint-postgres": minor
---

Add a `createSchema` option to `PostgresSaver` and `PostgresStore` for use alongside a custom `schema`. When `true` (the default), `setup()` runs `CREATE SCHEMA IF NOT EXISTS` as before. When `false`, `setup()` instead verifies the schema already exists and throws if it does not, without attempting to create it — useful for least-privilege database roles that are not permitted to create schemas. Table migrations still run either way. `createSchema` is only valid when a custom `schema` is provided, since the default `public` schema always exists.
