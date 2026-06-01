---
"@langchain/langgraph": patch
---

fix(langgraph): pass context with stateful RemoteGraph runs

Pop `thread_id` from run `config.configurable` and forward `context` to the SDK so checkpointed remote runs accept user context without a 400 from ambiguous parameters. Closes #1922.
