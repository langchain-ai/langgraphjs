---
"@langchain/langgraph-sdk": patch
---

With `reconnectOnMount`, a `stop()` before the server has answered the run's request now cancels that run. The `useStream` hook and `StreamOrchestrator` create these runs with `on_disconnect: "continue"`, and only the response carries the run id, so a stop that aborted the request left the run going on the server with no client knowing its id. The request now stays open until the id arrives, then exactly that run is cancelled and the request closed, while the UI still stops at once. A thread switch, a submit that interrupts the run, and a stop without `reconnectOnMount` abort the request at once, as before.
