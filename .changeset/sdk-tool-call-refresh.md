---
"@langchain/langgraph-sdk": patch
---

fix(sdk): re-parse streamed tool call args at most every 50ms instead of on every chunk

The `useStream` hook from `@langchain/langgraph-sdk/react` re-parsed a streaming tool call's full arguments on every `messages` chunk, so the work grew quadratically with the length of the arguments. It now reuses the previous parse and re-parses at most every 50ms, and once more when the stream ends. Subagent messages get the same treatment.

The `@langchain/core` peer dependency is raised from `^1.1.48` to `^1.2.18`, the first release that parses tool call chunks lazily. Older releases parse them on every chunk regardless, so they would get the delay without the speedup.
