---
"@langchain/langgraph": patch
---

Restore per-node `tracePolicy` and `omitPayload`, built on `@langchain/core`'s `RunnableSequence` trace policy (now requires `@langchain/core` >= 1.3.3). It only changes what `LangChainTracer` sends to LangSmith; execution, streaming, and other callbacks see raw values.
