---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): preserve non-empty response_metadata on protocol-v2 state messages

The protocol-v2 state normalizer stripped `response_metadata` from messages,
dropping data that HITL flows rely on — an interrupt's card is carried on
`AIMessage.response_metadata` (e.g. `{ cards: ... }`). Non-empty
`response_metadata` is now retained so the card reaches the client.
