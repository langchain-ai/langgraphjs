---
"@langchain/langgraph-sdk": patch
---

fix(sdk): URL-encode caller-supplied identifiers (thread, assistant, run, cron and checkpoint IDs, subgraph namespaces) in request paths so an untrusted ID can't redirect a request to another endpoint. IDs containing reserved characters such as `/`, `?`, `#`, `%` or spaces are now sent percent-encoded, so pass raw IDs rather than pre-encoded ones. `.` and `..` are no longer accepted as IDs: the method rejects with an `Invalid path segment` error instead of sending a request.
