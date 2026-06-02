---
"@langchain/langgraph-sdk": patch
---

fix(sdk): normalize HITL edit decisions for Python servers

`StreamController.respond()` now mirrors camelCase and snake_case on edit
decisions (`editedAction` / `edited_action`) so JS clients can resume
human-in-the-loop interrupts against Python LangGraph servers.
