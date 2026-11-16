---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator.resolveSubagentNamespace()` now finds the namespace of a subagent its run hasn't started yet. The engine lists a subagent as soon as the main agent's `task` call streams, before the run starts it and gives it a namespace. A lookup made then found nothing in the thread's history and resolved `undefined`, so a `@langchain/react` 2.0 panel opened on that subagent stayed empty, also after the subagent ran, unless the app passed the panel a newer copy of the subagent. Now a lookup that finds nothing while the run streams waits until the run starts the subagent, or until either ends, and looks again. A lookup whose run ends without starting the subagent still resolves `undefined`.
