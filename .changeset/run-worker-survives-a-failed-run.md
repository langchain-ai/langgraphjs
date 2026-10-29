---
"@langchain/langgraph-api": patch
---

Deleting a thread, or a run, while the run is running no longer stops one of the server's run workers for good, and neither does any other failure while a worker finishes a run, such as a webhook URL that can't be reached. After enough of these, new runs were never picked up.
