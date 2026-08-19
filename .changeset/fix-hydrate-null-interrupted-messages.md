---
"@langchain/langgraph-sdk": patch
---

fix(sdk): clear messages on hydrate(null) with a pending interrupt

Teardown awaited the paused root pump, so threadId went null while
the old conversation stayed on screen. Reset the snapshot first.
