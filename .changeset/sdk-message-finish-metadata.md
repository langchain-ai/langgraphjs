---
"@langchain/langgraph-sdk": patch
---

fix(sdk): surface message-finish response metadata on streamed messages

`stop_reason` didn't reach AI messages assembled from a live stream —
`response_metadata` was hardcoded to `{ output_version: "v1" }` — so clients
could not tell a turn-ending message from one about to call a tool without
waiting for a lifecycle event or reloading the page.

`MessageAssembler` also read the metadata from `responseMetadata`, which only
JS servers send; langchain-core sends `metadata`. Both spellings are now
accepted and merged into `response_metadata`.
