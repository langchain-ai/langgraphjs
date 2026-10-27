---
"@langchain/langgraph": patch
---

fix(langgraph): route a RemoteGraph's subgraph events like a local graph's when it streams inside a node

When a node streams a `RemoteGraph` and its parent graph is streamed with `subgraphs: true`:

- The node no longer receives the remote graph's subgraph events unless it passed `subgraphs: true` itself. With `streamMode: "updates"` it got `["model", "child"]` where a local graph gives `["child"]`. `messages` events are not filtered. The server sends each message once, from the namespace where it first saw it, so it never sends the top-level copy the node would get from a local graph, and filtering would leave the node with no messages.
- The parent now receives the remote graph's subgraph events, at every depth. Before, it received only the remote graph's top-level events.
- The same holds when the node passes `subgraphs: false`. Before, that turned off subgraph events for the parent too.
