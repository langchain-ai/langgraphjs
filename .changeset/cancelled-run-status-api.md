---
"@langchain/langgraph-api": patch
---

fix(api): abort cancelled runs with a recognizable cancel reason so tracers can trace them as `cancelled` instead of `error`
