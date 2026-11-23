---
"@langchain/langgraph-sdk": patch
---

fix(sdk): declare ESM scope for bundled dependency chunks

Emit a `{"type":"module"}` package.json into each bundled package directory under `dist/node_modules`, so the ESM chunks are no longer parsed as CommonJS on Node 22.0–22.6, which crashed consumers at import time with "Cannot use import statement outside a module".
