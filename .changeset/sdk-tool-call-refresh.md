---
"@langchain/langgraph-sdk": patch
---

fix(sdk): re-parse streamed tool call args at most every 50ms instead of on every chunk

The `useStream` hook from `@langchain/langgraph-sdk/react` re-parsed a streaming tool call's full arguments on every `messages` chunk, so the work grew quadratically with the length of the arguments. It now reuses the previous parse and re-parses at most every 50ms, and once more when the stream ends. Subagent messages get the same treatment.
