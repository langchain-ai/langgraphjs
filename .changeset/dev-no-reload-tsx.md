---
"@langchain/langgraph-api": patch
---

Fix `langgraph dev --no-reload` with the default TypeScript loader. Pass the tsx `--clear-screen=false` option only in watch mode so Node can start the server when reload is disabled.
