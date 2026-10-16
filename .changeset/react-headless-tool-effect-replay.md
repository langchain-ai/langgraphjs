---
"@langchain/react": patch
---

Preserve headless tool deduplication across React effect replay so pending tools execute only once, while still resetting handled IDs when the thread changes.
