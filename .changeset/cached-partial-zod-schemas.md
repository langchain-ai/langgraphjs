---
"@langchain/langgraph": patch
---

With a zod state schema, node updates and run input are validated with the cached partial schema instead of a new zod schema per update, which zod had to compile every time. A 50-step run on a 30-field zod state is 1.65x faster.
