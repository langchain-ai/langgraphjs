---
"@langchain/langgraph": patch
---

Channels written in one step share one version again: `_applyWrites` mints each version once, as Python does. A saver that adds a random fraction to its versions, as the Postgres and Redis savers now do, gave each channel its own, so `updateState` without `asNode` after two parallel nodes applied the update as either one instead of throwing "Ambiguous update".
