---
"create-langgraph": patch
"@langchain/langgraph-cli": patch
---

fix: replace `extract-zip` with `fflate` so template and `uv` extraction no longer hang on Node.js 24.16+ / 26
