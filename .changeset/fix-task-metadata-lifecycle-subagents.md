---
"@langchain/langgraph": patch
"@langchain/langgraph-checkpoint": patch
---

fix(langgraph): forward task metadata and name subagents via lc_agent_name

`mapDebugTasks` now forwards filtered user-meaningful task config metadata
(including `lc_agent_name`) onto `tasks` stream payloads. The lifecycle
transformer uses that metadata to set subagent `graph_name` from
`lc_agent_name` and recover `cause: { type: "toolCall", tool_call_id }`
from parent tool-dispatch tasks. Adds the shared `EXCLUDED_METADATA_KEYS`
constant to `@langchain/langgraph-checkpoint`. Ports langgraph#7928.
