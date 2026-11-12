---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` (`@langchain/langgraph-sdk/ui`) handles four cases the way `@langchain/react` 1.x apps expect:

- A thread switch no longer shows the last thread's messages, error or selected branch while the new thread loads. `values` falls back to `initialValues`, and `isThreadLoading` is `true` until the read lands.
- A thread id that doesn't exist yet, such as one minted in the browser for a new chat, loads as an empty thread with no error, and the first submit on it creates it with `POST /threads` and that id before its run, so the app's `threads.create` auth handler runs. A submit made while the thread loads waits for the load. A link to a deleted thread shows it empty, and its first submit creates it again. A thread that exists by the time of that create, such as one another tab created, is used as it is when the user's auth can read it, and refused otherwise.
- A tool call whose tool message has `status: "error"` reads as failed, with the message's text as `error`, instead of finished. This applies to `@langchain/react` 1.x too: after a reload, and when a tool returns an error message of its own, which the `tools` channel reports as finished.
- `resolveSubagentNamespace(toolCallId)` shares one lookup between callers that ask for the same subagent at the same time, so the hooks of one subagent panel read the thread's history once after a reload.
