---
"@langchain/langgraph-checkpoint-redis": patch
---

Use exact integer channel versions so RedisJSON round trips preserve the checkpoint blob keys. Keep randomized suffixes to distinguish sibling branches, and reject versions that exceed JavaScript's safe-integer range.
