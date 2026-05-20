---
"@langchain/langgraph-checkpoint": patch
---

fix(langgraph-checkpoint): block prototype pollution in MemorySaver via reserved storage keys

`MemorySaver` previously embedded `thread_id`, `checkpoint_ns`,
`checkpoint_id`, and `task_id` directly into property accesses on the
nested plain objects `this.storage` and `this.writes`. A caller able to
shape any of those fields (every quickstart, tutorial, and test fixture
uses `MemorySaver` by default) could pass `"__proto__"`,
`"constructor"`, or `"prototype"` and have the subsequent assignment
mutate `Object.prototype`. From that point every plain object in the
process inherits the injected property, breaking `for...in` loops,
truthy short-circuits, and downstream serializers across unrelated code
paths. CWE-1321.

Adds an `assertSafeStorageKey` chokepoint applied at every public entry
that touches `storage` or `writes` (`put`, `putWrites`, `deleteThread`,
`getTuple`, `list`). The guard rejects non-string values, the empty
string (unless explicitly opted-in for `checkpoint_ns`), and the three
prototype-pollution keys. Behaviour for valid string identifiers is
unchanged.
