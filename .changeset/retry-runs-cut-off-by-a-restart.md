---
"@langchain/langgraph-api": patch
---

Runs that were running when the dev server restarted, for example on a hot reload after a file save, are now retried when it starts again and continue from their last checkpoint. Before, they stayed `running` forever, their thread stayed busy and new runs on it were rejected with 422.
