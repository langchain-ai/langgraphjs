---
"@langchain/langgraph-cli": patch
---

Keep the host backend request timeout active until the response body has been read, so deployment commands cannot hang indefinitely after receiving headers.
