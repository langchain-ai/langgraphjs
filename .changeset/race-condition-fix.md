---
"@langchain/langgraph-core": patch
---

Fix race condition in IterableReadableWritableStream.push() that caused ERR_INVALID_STATE errors when streaming with multiple parallel nodes and aborting the stream.