---
"@langchain/langgraph-checkpoint-mongodb": patch
---

Widen the `mongodb` dependency range to `^6.21.0 || ^7.0.0`.

The range was pinned to `^6.21.0`, which is the final v6 release, so applications already on the v7 driver were forced to install a second copy of `mongodb` alongside their own.

The driver surface this package uses — `MongoClient`, `Db`, `collection()`, `find()`, `findOne()`, `deleteMany()`, `createIndex()`, `bulkWrite()` and `aggregate()` — is unchanged between v6 and v7. Both majors remain supported, and existing installs are unaffected.
