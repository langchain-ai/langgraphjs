---
"@langchain/langgraph": patch
---

Honor node timeouts longer than the platform timer limit without overflowing to a 1 ms run timeout or repeatedly polling long idle deadlines.
