---
"@langchain/langgraph-sdk": patch
---

fix(sdk): resume the protocol SSE stream from the last `event_id` on reconnect

A transport-level reconnect (network blip, idle-watchdog reopen) now carries
the last durable `event_id` it saw as `last_event_id`, so the server resumes
from the thread tape instead of replaying the whole conversation, and still
delivers the terminal `run_done` a bare reconnect would miss once the tape has
moved on. `seq` is connection-local and is never used as a cursor. Filter
rotations open a fresh stream and keep full-replaying for the widened filter,
so the cursor never leaks across them.
