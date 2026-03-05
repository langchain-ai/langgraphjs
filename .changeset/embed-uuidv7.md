---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): use UUIDv7 instead of UUIDv4 in embed server

Switches thread and run ID generation from `uuidv4` to `uuidv7` in the experimental embed server. UUIDv7 is time-ordered, which improves sortability and database index performance for IDs.
