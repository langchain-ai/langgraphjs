---
"@langchain/langgraph-sdk": patch
---

When the `threadId` option of `useStream` changes while the last run's values still hold a pending headless tool call, the hook no longer runs that tool again. It also no longer resumes the new thread, or a thread it creates after a switch to `null`, with the previous thread's interrupt id. Passing back the `threadId` of a thread `submit` created no longer runs its pending tool again either.
