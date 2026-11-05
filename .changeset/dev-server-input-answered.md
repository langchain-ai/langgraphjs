---
"@langchain/langgraph-api": minor
---

feat(langgraph-api): a run that answers interrupts by id tells the thread's other protocol clients which ones, with an `input.answered` event on the `input` channel; run streams don't carry it
