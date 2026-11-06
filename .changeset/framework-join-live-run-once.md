---
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

`joinStream(runId)` now does nothing when `runId` is the run already being streamed (from `submit()` or an earlier join, including the one started by `reconnectOnMount`) or already queued, instead of replaying the whole run with a second loading phase once the current stream ends.
