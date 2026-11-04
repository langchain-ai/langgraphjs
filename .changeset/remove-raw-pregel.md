---
"@langchain/langgraph": minor
---

Remove building graphs by hand with `Channel` and `new Pregel(...)`

Building a graph by constructing `Pregel` with `Channel.subscribeTo()` and `Channel.writeTo()` nodes was never meant to be public. Graphs are built with `StateGraph` or `entrypoint`.

- `Channel` is removed from `@langchain/langgraph/pregel`, and the `SingleChannelSubscriptionOptions` and `MultipleChannelSubscriptionOptions` types are removed from `@langchain/langgraph`.
- `new Pregel(...)` throws a `TypeError` that points to `StateGraph` and `entrypoint`. `Pregel` stays exported as the type that `compile()` and `entrypoint` return, for type annotations and `instanceof` checks.

This matches the same change in Python LangGraph.
