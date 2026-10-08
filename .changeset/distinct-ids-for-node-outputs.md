---
"@langchain/langgraph": patch
---

fix(langgraph): give node outputs distinct message ids

`StreamMessagesHandler._emit` assigned every id-less message of a run the same
`stableMessageIdMap[runId]`. That map exists so the chunks of one LLM run share
an id and clients can merge them, but `handleChainEnd` reused it for node
outputs, which are distinct messages rather than chunks of one. Since
`messagesStateReducer` deduplicates by id, a node returning two id-less messages
lost one of them from graph state — and only under `streamMode: "messages"`, so
the same graph kept both under `"updates"` and `"values"`.

Node outputs are now distinguished by their position, the way tool messages are
already distinguished by tool call id. The token path is untouched: the new
argument is only ever passed from `handleChainEnd`.
