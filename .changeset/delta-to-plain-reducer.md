---
"@langchain/langgraph": patch
---

A field that changes from a DeltaChannel to a plain reducer, for example to `MessagesAnnotation`, keeps its value on threads written under the DeltaChannel: reads rebuild it from the stored writes instead of returning the empty default, and the next run adds to it instead of replacing it.
