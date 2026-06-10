---
"@langchain/langgraph-supervisor": minor
---

feat(langgraph-supervisor): Add `addHandoffMessages` to `createSupervisor` and `createHandoffTool`, allowing supervisor-to-agent handoff bookkeeping messages to be omitted from the expert agent's message history. When `addHandoffBackMessages` is not provided, it now defaults to the same value as `addHandoffMessages`, matching the Python package behavior.

`createHandoffTool` now also accepts `description` as the preferred option name while continuing to support the existing `agentDescription` option as deprecated for backwards compatibility.
