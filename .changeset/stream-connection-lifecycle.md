---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

Expose connection lifecycle callbacks for built-in streaming transports.

`onConnected` runs after the initial SSE or WebSocket connection becomes usable and after every successful reconnect. Its payload distinguishes an `initial` connection from a `reconnected` connection and includes the reconnect attempt number.

`onReconnect` now also receives the scheduled `delayMs`, allowing applications to display accurate retry state before the next connection attempt. React, Vue, Svelte, and Angular stream hooks forward both callbacks.
