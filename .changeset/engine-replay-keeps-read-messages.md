---
"@langchain/langgraph-sdk": patch
---

A join that replays a run no longer restarts a message the page shows as it read it, while that copy is shown. Its replayed chunks used to blank it, then stream it again from the start. A whole message the replay sends still replaces it. `useStream` from `@langchain/langgraph-sdk/react` gets the same fix.
