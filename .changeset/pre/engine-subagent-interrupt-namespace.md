---
"@langchain/langgraph-sdk": patch
---

An interrupt raised in a subagent that runs inside a tool call, as deep agents' subagents do, now carries that subagent's namespace in `interrupts` and `getThread().interrupts`. It read `[]`, so an app couldn't tell which subagent was waiting on it. `useStream` from `@langchain/react` gets the same change.
