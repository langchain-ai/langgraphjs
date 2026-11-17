---
"@langchain/langgraph-api": patch
"@langchain/langgraph-cli": patch
"@langchain/langgraph-ui": patch
---

fix(langgraph-api): preserve additional_kwargs in protocol state normalizer

Forward non-empty `additional_kwargs` on values snapshot messages so
server-authored message metadata (e.g. committed attachment paths) reaches
live subscribers.
