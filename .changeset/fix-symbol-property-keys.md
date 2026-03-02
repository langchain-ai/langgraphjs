---
"@langchain/langgraph": patch
---

fix: add explicit `: symbol` type annotations to symbols used as computed property keys

TypeScript infers `unique symbol` type when Symbol.for() is used without an explicit type annotation. When these symbols are used as computed property keys on classes, this causes type incompatibility when multiple versions of the same package are present in a dependency tree.

By adding explicit `: symbol` annotations to symbols used as property keys, all declarations now use the general symbol type, making them compatible across versions while maintaining identical runtime behavior.

Changes:
- Added `: symbol` to `COMMAND_SYMBOL` (used on CommandInstance class)
- Added `: symbol` to `REDUCED_VALUE_SYMBOL` (exported, used on ReducedValue class)
- Added `: symbol` to `UNTRACKED_VALUE_SYMBOL` (exported, used on UntrackedValue class)

This follows the same pattern as langchain-ai/langchainjs#10243
