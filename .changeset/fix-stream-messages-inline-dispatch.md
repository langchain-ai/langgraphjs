---
"@langchain/langgraph": patch
---

fix(langgraph): dispatch stream messages handler inline

The v3 `messages` handler (`StreamProtocolMessagesHandler`, which powers
`run.messages`) only performs a synchronous `push()` onto the run's stream, but
its callbacks were dispatched on LangChain's background callback queue (the
default `awaitHandlers === false`). A model or tool call inside a nested or
parallel task could therefore flush its `messages` chunk *after* the Pregel
loop returned and sealed the stream, where `IterableReadableWritableStream.push`
silently drops chunks once closed. This surfaced as empty per-message streams
(`sub.messages`) for subagents dispatched in parallel from a single tools step.

The handler now sets `awaitHandlers = true` so its callbacks run inline — every
push happens during the originating model/chain call while the stream is still
open. This avoids the global over-wait, fake-timer deadlock, and error-path
unhandled rejections that a blanket `awaitAllCallbacks()` drain before close
would have introduced.
