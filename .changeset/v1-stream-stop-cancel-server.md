---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

feat(stream): cancel runs on stop by default and add disconnect()

`stream.stop()` now calls `client.runs.cancel` for the active run before disconnecting the client (default `{ cancel: true }`). Join/rejoin UIs can call `stream.disconnect()` or `stop({ cancel: false })` to leave the agent running server-side.
