---
"@langchain/langgraph-cli": patch
---

`langgraphjs deploy` local builds log in with the registry username the control plane returns and push to its `repository_url` when it sends one, so they work on LangSmith AWS. Control planes that return neither keep the previous behavior.
