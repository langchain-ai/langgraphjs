---
"@langchain/langgraph": minor
---

feat(langgraph): add Overwrite class for bypassing channel reducers

Adds an `Overwrite` class and `OverwriteValue` type that allow nodes to bypass reducers in `BinaryOperatorAggregate` channels, writing values directly instead of passing them through the reducer function. This is useful when a node needs to replace accumulated state rather than append to it.

- New `Overwrite` class exported from `@langchain/langgraph`
- `BinaryOperatorAggregate` channel detects `OverwriteValue` and sets the value directly
- `Annotation`, `StateSchema`, and zod schema type mappings updated to include `OverwriteValue` in update types
