---
"@langchain/langgraph-sdk": patch
---

With `reconnectOnMount`, a `stop()` from `useStream` before the server has answered the run's request now cancels that run once its id arrives. The hook creates these runs with `on_disconnect: "continue"`, and only the response names the run, so the stop used to close the request and leave the run going on the server. The request now stays open for up to 5 seconds to learn the id, while the UI still stops at once.
