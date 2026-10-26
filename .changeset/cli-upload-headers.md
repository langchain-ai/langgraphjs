---
"@langchain/langgraph-cli": patch
---

`langgraphjs deploy --remote` sends the headers the control plane returns with its source upload, so uploads work with storage that needs extra headers, such as Azure Blob Storage. Control planes that return none keep the previous behavior.
