---
"@langchain/langgraph": patch
---

Add `GraphCallbackHandler` with typed `handleInterrupt` and `handleResume` events through normal callback configuration, matching Python graph lifecycle behavior. Lifecycle callbacks are awaited before terminal chain callbacks and work independently of stream mode.
