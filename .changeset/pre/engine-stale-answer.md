---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` now shows an answer that another tab sent first as answered there. When two tabs answered the same interrupt at once, the Agent Server ran the first answer and refused the second with `UnknownInterruptError`, since `respond()` and `respondAll()` ask for a strict resume. The tab whose answer was refused showed that error, showed the interrupt again as if unanswered, and showed the reply only after a reload. A tab that joined the refused run showed the error too. Such a run's error now reaches `onError` but not `error`, the thread is read again so the reply shows, and the answered interrupts stay hidden until that read lands, which shows them again only if they are still pending, or for at most 10 s if it hangs. A refused answer also no longer ends the subagents still open with `The run ended: error`, since it ran no step.
