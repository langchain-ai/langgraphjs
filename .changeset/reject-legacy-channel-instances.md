---
"@langchain/langgraph": patch
---

Reject channel instances passed to the legacy reducer-descriptor constructor option with an actionable schema error instead of silently corrupting their behavior.
