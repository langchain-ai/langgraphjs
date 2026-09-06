---
"@langchain/langgraph-api": patch
---

fix(api): `run.start` with input on a cancelled thread no longer folds the input into `Command(resume)`. A cancelled run shares the "interrupted" status with a genuine `interrupt()` pause, but has no pending interrupt to consume the resume value, so the submitted message was silently dropped. The input-vs-resume decision now keys on whether the thread actually has pending interrupts (both in the protocol service and the embed protocol).
