---
"@langchain/langgraph": patch
"@langchain/langgraph-sdk": patch
---

fix: add explicit `: symbol` type annotations to Symbol.for() declarations for cross-version compatibility

TypeScript infers `unique symbol` type when Symbol.for() is used without an explicit type annotation, causing type incompatibility when multiple versions of the same package are present in a dependency tree. By adding explicit `: symbol` annotations, all declarations now use the general symbol type, making them compatible across versions while maintaining identical runtime behavior.

Changes:
- Added `: symbol` to all Symbol.for() declarations across langgraph-core, langgraph-sdk, langgraph-api, and langgraph-ui packages
- This ensures symbols work correctly when multiple versions of packages coexist in the dependency tree
