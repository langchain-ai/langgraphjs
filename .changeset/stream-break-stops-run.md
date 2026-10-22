---
"@langchain/langgraph": patch
---

Stop the run when a consumer breaks out of a `for await` loop over `graph.stream()` or `graph.streamEvents()`, or cancels the stream's reader. Only an explicit `stream.cancel()` aborted the run before; breaking out of the loop left the remaining nodes running in the background.
