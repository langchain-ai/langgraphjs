---
"@langchain/langgraph-checkpoint": patch
---

Replace an item's vector index when its value or indexing fields change, removing stale vectors after shrinking arrays, removing fields, or disabling indexing. Prepare all new vectors before applying updates so embedding failures leave existing values and vectors unchanged.
