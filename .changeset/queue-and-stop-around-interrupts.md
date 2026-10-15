---
"@langchain/langgraph-sdk": patch
---

`useStream` no longer sends a queued message to a thread that is waiting on an interrupt. The message used to start as soon as the run paused, where the server either refused it or took it as the interrupt's answer. It now stays queued until the interrupt is answered, here or from another tab, and messages queued after it wait behind it.

A message the server refuses because interrupts are open no longer hides them, and `respond()` without an interrupt id can answer them. An interrupt answered by a resumed run that fails, or that `stop()` cancels, shows again.

`stop()` after `respond()` or `respondAll()` now cancels the resumed run on the server instead of only disconnecting from it.
