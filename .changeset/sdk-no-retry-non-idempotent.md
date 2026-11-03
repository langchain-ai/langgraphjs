---
"@langchain/langgraph-sdk": patch
---

The client no longer sends a `POST` or `PATCH` request again after it may have reached the server, so a retry can no longer create a second run or repeat a protocol command. These requests are now retried only when the connection failed before they were sent (for example, the connection was refused or the host was not found). `GET`, `HEAD`, `OPTIONS`, `PUT` and `DELETE` requests are retried as before.
