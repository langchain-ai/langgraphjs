---
"@langchain/langgraph": patch
---

Fix `runtime.store` being undefined when accessing the store from within node functions or middleware. The store is now properly attached to the runtime config, making it accessible via `runtime.store` in all graph types (StateGraph, prebuilt agents, etc.).
