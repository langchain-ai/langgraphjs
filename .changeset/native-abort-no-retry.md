---
"@langchain/langgraph-sdk": patch
---

Stop retrying native AbortError and TimeoutError exceptions by recognizing their error names, avoiding retry delays after requests are cancelled or time out.
