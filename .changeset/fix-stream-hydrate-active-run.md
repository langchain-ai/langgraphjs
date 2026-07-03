---
"@langchain/langgraph-sdk": patch
---

fix(sdk): reattach streams when hydrate sees an active run

Check for a pending or running run when `getState()` returns an idle-looking checkpoint so refreshed clients reconnect instead of rendering an idle chat while the run continues server-side.
