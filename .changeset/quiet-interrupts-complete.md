---
"@langchain/langgraph": patch
---

Report only pending interrupts in the latest checkpoint state after partial resumes, while preserving recorded interrupts in history and explicit-checkpoint reads. Keep tasks paused at a subsequent interrupt in `next`, and record completion for resumed tasks that return no output so they are not executed again.
