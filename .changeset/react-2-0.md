---
"@langchain/react": major
---

2.0 keeps 1.x's hooks, their names and their arguments, on a new streaming engine: the stream engine of `@langchain/langgraph-sdk/ui`, over the Agent Server's run streams instead of the event streaming protocol 1.x used. Most apps upgrade by changing the version.

2.0 depends on the exact `@langchain/langgraph-sdk` version it was released with. An app that builds its own `Client` should take it from that version.

Everything that changed, and how to get 1.x's behavior back: https://github.com/langchain-ai/langgraphjs/blob/react-2.0/libs/sdk-react/docs/v2-migration.md
