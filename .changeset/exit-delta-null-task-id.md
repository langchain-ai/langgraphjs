---
"@langchain/langgraph": patch
---

fix(langgraph): exit-mode DeltaChannel writes are never stored under the null task id. A run that started at step 0 with a `Command` update, such as a new thread started with `Command({ update, goto })` under `durability: "exit"`, stored the update under `NULL_TASK_ID`, so reading or replaying that first checkpoint applied it to the DeltaChannel but not to plain channels.
