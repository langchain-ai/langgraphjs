---
"@langchain/langgraph-checkpoint-redis": patch
---

fix(redis): escape RediSearch filter values

Added proper escaping for filter keys and values when constructing RediSearch queries
in the `list()` method to handle special characters correctly.
