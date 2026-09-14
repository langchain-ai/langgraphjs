---
"@langchain/langgraph-checkpoint-redis": patch
---

Check exact namespace boundaries before returning search results or selecting records for get, update, and delete. Apply namespace pagination after filtering candidates. No setup, index, or document migration is required. Scoped searches may inspect the entire index and repeat vector queries to fill a page.
