---
"@langchain/langgraph-sdk": patch
---

fix(sdk): bundle pure-ESM deps into CJS build to fix ERR_REQUIRE_ESM

Bundle the pure-ESM dependencies `p-retry` and `p-queue` (and their transitive ESM-only deps) into the build output so the CJS artifact no longer does a top-level `require()` of an ESM module. This fixes `ERR_REQUIRE_ESM` for CommonJS consumers on Node versions where `require(ESM)` is not enabled by default (< 20.19 / < 22.12). Closes #2562.
