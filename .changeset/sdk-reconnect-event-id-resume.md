---
"@langchain/langgraph-sdk": patch
---

fix(sdk): resume the protocol SSE stream from the last `event_id` on reconnect

A transport-level reconnect (network blip, idle-watchdog reopen) now sends the
last durable `event_id` it saw as the standard `Last-Event-ID` header, so a
server that supports it resumes from the thread's event stream instead of
replaying the whole conversation, and still delivers the terminal `run_done` a
bare reconnect would miss once the stream has moved on. The request body is
unchanged, so servers with a strict body schema keep working and ignore the
header. Only ids with the durable `ms-seq` shape are sent; `seq` is
connection-local and never used as a cursor. Filter rotations open a fresh
stream and keep full-replaying, so the cursor never crosses rotations.
