---
"@langchain/langgraph-cli": patch
---

Only retry deployment POST/PATCH requests when the connection failed before sending them, preventing duplicate mutations after lost responses or request timeouts.
