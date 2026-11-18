---
"@langchain/langgraph": patch
---

In a run whose `config.metadata.run_id` is a UUID, input messages without an id in `messagesStateReducer` and `DeltaChannel(messagesDeltaReducer)` channels get `inputMessageId(runId, channel, index)`, the same id LangGraph Python derives. `inputMessageId` is exported.
