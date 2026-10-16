---
"@langchain/langgraph": patch
---

With `durability: "exit"`, resuming parallel interrupts one at a time no longer applies a finished task's output twice: the save at exit keeps only the writes made during that run, instead of storing the ones loaded with the checkpoint again under new indexes.
