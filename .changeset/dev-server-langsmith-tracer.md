---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): honor `langsmith_tracer` on the protocol's `run.start`

`langsmith_tracer` is part of the protocol's `RunStartParams`, the SDK sends it when `thread.run.start()` is given one, and the legacy run endpoints and the embed server both fold it into `config.configurable` as `langsmith_project` / `langsmith_example_id`. The protocol path dropped it, so a run started over the dev server's protocol transport — SSE or WebSocket — traced to the deployment's default LangSmith project instead of the one the caller asked for. `run.start` now reads the field (ignoring a non-object value instead of failing the run) and folds it into the run config the same way the other endpoints do.
