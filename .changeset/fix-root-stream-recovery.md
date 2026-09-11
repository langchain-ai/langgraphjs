---
"@langchain/langgraph-sdk": patch
---

Recover cleanly when a thread's root event stream terminates unexpectedly.

If the stream fails or closes while a run is active, the controller now records the transport error and clears `isLoading` rather than leaving the UI in a permanently running state. Once the failed pump settles, a later submission can start a fresh root subscription without recreating the thread stream or replaying the failed command.
