---
"@langchain/langgraph-checkpoint": patch
---

fix(checkpoint): allow reviving non-core classes from checkpoints

`JsonPlusSerializer` called `load()` from `@langchain/core/load` with no options, so only the `langchain_core` namespace could be resolved. Reading back a checkpoint containing any object from another package (for example `ChatOpenAI`, whose namespace is `langchain`) threw `Invalid namespace`. The serializer now accepts `LoadOptions` and forwards them to `load()`, and is exported from the package entrypoint so applications can opt those classes in:

```ts
new MemorySaver(new JsonPlusSerializer({ importMap: { ... } }))
```

Defaults are unchanged — with no options the serializer resolves exactly what it did before.
