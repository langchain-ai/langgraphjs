---
"@langchain/langgraph-sdk": patch
---

fix(sdk): stop resolved interrupts from coming back after a reload

After a reload, the first submit or respond on the Agent Server brought back every interrupt the thread had already resolved, and accepting them failed with `no_such_interrupt`. Its HTTP commands report `applied_through_seq: 0`, so the SDK treated the whole replayed history as new. When a command reports 0, the SDK now finds where the command's run starts on the thread stream and treats everything before it as history.
