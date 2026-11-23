---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` no longer shows an interrupt answered in another tab again while it reads the thread after the answering run. When that run ended before this tab joined it, the interrupt came back as soon as the run ended, from the state read before the answer, until the next read landed. It now stays hidden until that read lands, which shows it again only if it is still pending. If the read takes over 10 s, it shows again then.
