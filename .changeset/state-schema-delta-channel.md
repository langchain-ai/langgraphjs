---
"@langchain/langgraph": patch
---

fix(langgraph): support DeltaChannel fields in StateSchema

Add a `DeltaValue` state field (and a `MessagesDeltaValue` prebuilt) so a
`DeltaChannel` can be declared via `StateSchema`, not just `Annotation.Root` or
a raw channel map. `StateSchema` now maps `DeltaValue` to a `DeltaChannel`
(forwarding `snapshotFrequency` and the value-schema default) and validates its
inputs/`Overwrite` updates like `ReducedValue`.
