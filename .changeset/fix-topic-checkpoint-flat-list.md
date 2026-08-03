---
"@langchain/langgraph": patch
---

fix(langgraph): checkpoint Topic as a flat values list

Match Python Topic checkpoints so Host JS graphs no longer put `__pregel_tasks: [[], []]` through the Python checkpointer. Keep reading legacy `[seen, values]` checkpoints for restore compatibility.
