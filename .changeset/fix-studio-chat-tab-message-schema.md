---
"@langchain/langgraph-api": patch
---

fix(langgraph-api): restore the full message union in generated schemas

langchain v1 parameterized the `BaseMessage` hierarchy, which broke three assumptions in the static schema generator and left the `messages` channel with a degenerate `oneOf: [RemoveMessage]`. Studio then stopped recognizing messages graphs and greyed out the Chat tab.

Key the class-hierarchy map on the base name with generic arguments erased, pull the concrete message subclasses into the generated program so they are discovered at all, leave properties whose types cannot be modeled (`$InferToolCalls<TStructure>`) unconstrained instead of failing the whole schema, and emit the message definitions under their bare names. The `messages` schema now matches what the v0 line produced. Fixes #2574.
