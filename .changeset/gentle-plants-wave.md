---
"@langchain/langgraph-api": minor
---

Add the thread-scoped event streaming protocol used by the new SDK streaming
clients.

This release adds protocol routes for WebSocket and SSE/HTTP streaming,
including thread-local command handling, filtered subscriptions, event replay,
state inspection, checkpoint listing/forking, interrupt input, agent tree
queries, and run start/resume commands. Stream events are normalized into the
canonical protocol shape with ordered sequence IDs so clients can safely
dedupe, resume subscriptions, and coordinate multiple projections from the same
run.

The experimental embed server now supports the same protocol flow, so embedded
graphs can serve the new SDK transports without standing up a separate
LangGraph API deployment. The server also gains protocol session tests and
fixture graphs covering deep agents, interrupts, subgraphs, and SDK transport
behavior.
