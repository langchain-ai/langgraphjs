---
"@langchain/langgraph-sdk": patch
---

fix(sdk): four `StreamManager` fixes for the `useStream` hook

- With `streamSubgraphs`, values from a subgraph that is not a subagent no longer replace the root state while the subgraph runs. Its results show once its node returns.
- A numeric `throttle` notifies at most once per interval while values keep changing, as documented, instead of waiting until they stop.
- A run abandoned by `clear()` or `stop()` no longer runs `onSuccess`, so a thread switch during a reconnect backoff no longer loads the previous thread's history.
- After a reload, a subagent delegated by an older turn is no longer shown with the tool results of a newer turn.
