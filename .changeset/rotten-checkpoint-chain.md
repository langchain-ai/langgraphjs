---
"@langchain/langgraph": patch
---

Report checkpointer failures under "async" durability without crashing the process, and keep checkpointing after a failed `put()` instead of silently skipping the rest of the run.
