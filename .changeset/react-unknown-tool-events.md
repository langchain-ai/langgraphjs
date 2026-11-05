---
"@langchain/react": patch
---

`useStream` ignores a `tools` event of a kind it doesn't know, such as langgraph's own `tool-started` payload, instead of throwing `Unexpected tool event` inside a state update, which crashed the app's render.
