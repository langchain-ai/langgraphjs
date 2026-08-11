---
"@langchain/langgraph-sdk": patch
---

fix(sdk): defer stream join until lazy thread create commits

Hydrating an externally-minted thread id that 404s still opened `/stream/events` before `POST /commands` created the row. On langgraph_api's in-mem runtime that join is accepted but dead, so the first run delivered nothing until idle reconnect. Treat missing threads like client-minted ones and start the root pump only after dispatch succeeds.
