---
"@langchain/langgraph": patch
"@langchain/langgraph-api": patch
---

A run stopped through its abort signal now ends its root run with an error whose `cause` is the signal's reason, so a tracer can tell an intentional stop from a failure. The Agent Server aborts a cancelled, interrupted or rolled-back run with a `RunCancellation`, which extends `ExpectedCancellation` from `@langchain/core/errors`.
