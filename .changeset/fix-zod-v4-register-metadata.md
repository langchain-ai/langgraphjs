---
"@langchain/langgraph": patch
---

Fix Zod v4 .register() metadata preservation for MessagesAnnotation. The metadata registry now properly stores and retrieves langgraph_type metadata when using Zod v4's .register() method, ensuring the Chat tab is enabled in LangGraph Studio for agents using MessagesAnnotation.
