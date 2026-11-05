---
"@langchain/langgraph-api": patch
---

Run streams on the dev server take the `lifecycle` stream mode: an event named `lifecycle|<namespace>` when each subgraph starts and when it ends (`completed`, `failed` or `interrupted`), with the id of the tool call that started it. `/info` reports `stream_lifecycle`.
