---
"@langchain/langgraph-sdk": patch
---

fix(sdk): copy `defaultHeaders` when constructing a `Client` instead of writing `x-api-key` into the caller's object. Previously, clients created from the same `defaultHeaders` object shared one set of headers, so a later client's API key was sent by earlier clients, and a client created with no API key could send another client's key to its own `apiUrl`.
