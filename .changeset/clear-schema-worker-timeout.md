---
"@langchain/langgraph-api": patch
---

Clear the schema extraction worker's timeout when the worker fails or exits, not only when it returns a result. The armed timer kept the event loop alive, so a failed extraction held the image prebuild (`build.mts`) open until the timeout fired, adding 120 s to every image build.
