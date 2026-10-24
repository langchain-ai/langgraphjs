---
"@langchain/langgraph-api": patch
---

The `rollback` multitask strategy, and cancelling with `action=rollback`, now roll back a run that is already running, as they already did for a pending one: the run is cancelled, then deleted with its checkpoints, so the next run starts from the state before it, and its stream ends without an error. Before, the run ended as `error` and its writes stayed on the thread. Runs that were running when the dev server restarted, for example on a hot reload after a file save, are now retried when it starts again and continue from their last checkpoint. Before, they stayed `running` forever, their thread stayed busy and new runs on it were rejected with 422. Deleting a thread, or a run, while the run is running no longer stops one of the server's run workers for good, and neither does any other failure while a worker finishes a run, such as a webhook URL that can't be reached. After enough of these, new runs were never picked up.
