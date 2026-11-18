---
"@langchain/langgraph-cli": patch
---

`langgraphjs deploy` no longer sends an empty `secrets` list when it updates a deployment and finds no variables to send. The control plane already kept the existing variables in that case; the request now says so explicitly. Creating a deployment still sends `secrets`.
