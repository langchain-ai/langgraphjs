---
"@langchain/langgraph-sdk": patch
---

Add a `reason` option to `client.runs.cancel`. Set `reason: "taken"` to mark run input absorbed for steering; the server records a `cancel_reason` starting with `taken:`.
