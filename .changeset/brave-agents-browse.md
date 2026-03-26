---
"@langchain/langgraph": patch
---

feat: add browser support for interrupt, writer, and other Node-only exports

Export `interrupt`, `writer`, `pushMessage`, `getStore`, `getWriter`, `getConfig`, `getPreviousState`, `getCurrentTaskInput` from `web.ts` and add a `"browser"` condition to the `"."` package export so browser bundlers resolve to `web.js` instead of pulling in `node:async_hooks`.
