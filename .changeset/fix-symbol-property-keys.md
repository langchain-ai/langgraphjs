---
"@langchain/langgraph": patch
---

fix: add explicit `: symbol` type annotations to exported symbols

TypeScript infers `unique symbol` type when Symbol.for() is used without an explicit type annotation. When these symbols are used as computed property keys on classes, this causes type incompatibility when multiple versions of the same package are present in a dependency tree.

By adding explicit `: symbol` annotations to **exported** symbols, all declarations use the general symbol type, making them compatible across versions while maintaining identical runtime behavior.

Changes:
- Added `: symbol` to `REDUCED_VALUE_SYMBOL` (exported, used on ReducedValue class)
- Added `: symbol` to `UNTRACKED_VALUE_SYMBOL` (exported, used on UntrackedValue class)

Internal symbols like `COMMAND_SYMBOL` are left unchanged to avoid TypeScript type inference issues with cross-module exports.

This follows the same pattern as langchain-ai/langchainjs#10243
