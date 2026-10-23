---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(langgraph-api): stamp run_id on protocol v2 event envelopes

Clients need a durable run identity to ignore replayed events from older
runs after hydrate + first submit. Connection-local `seq` cannot do that.
