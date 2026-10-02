---
"@langchain/langgraph-api": minor
---

Add `maxQueuedEvents` to `createEmbedServer`'s options. The embed protocol buffers every event of every run per thread so a late-attaching `/stream/events` subscriber can replay history it missed; on a thread whose graph never interrupts, nothing ever clears that buffer, so it grows for the life of the process. `maxQueuedEvents` caps it, evicting the oldest events first while always keeping the newest one. Leaving it unset preserves today's unbounded behavior exactly.
