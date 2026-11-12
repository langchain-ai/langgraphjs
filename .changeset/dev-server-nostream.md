---
"@langchain/langgraph-api": patch
---

The `messages` and `events` stream modes now skip calls tagged `nostream` or `langsmith:nostream` (LangGraph.js's `TAG_NOSTREAM`), as `messages-tuple` already does. Before, `messages` streamed the tokens of calls tagged `langsmith:nostream`, and `events` streamed every tagged call. In `events` mode the skip covers everything that runs inside a tagged call, so a run whose config tags are `nostream` streams no `events`.
