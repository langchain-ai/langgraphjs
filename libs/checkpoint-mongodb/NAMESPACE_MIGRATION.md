# Namespace encoding upgrade

MongoDBStore previously joined labels with `/` for its unique key and vector
filter. `["tenant", "a/b"]` and `["tenant", "a", "b"]` consequently shared those
representations. The upgraded store encodes complete arrays with JSON.stringify;
ordinary segment search and exact get/update/delete keep their array queries.
Listing wraps labels in `$literal` so `$`-prefixed labels stay data.

Existing stores require a maintenance window:

1. Stop all clients that read or write this store, including old application versions.
2. Construct MongoDBStore with the existing client, database, collection, and vector configuration (do not use fromConnString, which starts automatically).
3. Run `await store.migrateNamespaceEncoding()`. It fills `namespaceKey` and
   `namespacePrefixes`, creates the replacement unique index, then removes the
   old `namespaceStr_1_key_1` index. It preserves values, embeddings and timestamps.
   The operation can be rerun after interruption; keep clients stopped until complete.
4. Run `await store.start()`. With vector search configured, this creates
   `<configured-index-name>_namespace_v2`, filtering on `namespacePrefixes`.
5. Wait for the new search index to become READY and for indexed document counts
   to catch up. Verify scoped searches before resuming upgraded clients.

Do not resume old clients after migration. There is no fallback to the ambiguous
old vector filter. Keep the old vector index until the rollout is verified; it
can then be removed explicitly. A rollback requires a separately planned data
migration because new namespaces may be impossible to represent uniquely in the
old encoding. Back up the collection before migration.

Fresh stores need no migration. `start()` refuses legacy documents or the old
unique index, including an empty legacy collection. Custom legacy indexes must
be inventoried separately; the helper removes only the known default index.
