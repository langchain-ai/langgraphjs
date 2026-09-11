---
"@langchain/langgraph": patch
---

fix(core): merge callbacks without re-registering handlers both configs already hold

At a nested-runnable boundary the ambient AsyncLocalStorage config and
the child config carry the same handler instances. Concatenating them
re-registered every handler once per boundary, so a `LangChainTracer`
attached to a run tripled every `on_chat_model_stream` event two
subgraph levels deep (#2570). The Python runtime does not duplicate in
this situation.
