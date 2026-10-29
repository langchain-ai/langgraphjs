---
"@langchain/langgraph-sdk": patch
---

With history enabled, `submit` in the `useStream` hook and `StreamOrchestrator` no longer pins the run to the cached head of the shown branch when the latest branch is shown, so turns added elsewhere since the history was read (another tab, a cron, an API call, or this tab's own earlier run when a second submit was queued behind it) stay on the shown branch instead of moving to a sibling branch. A shown branch whose head is not the newest loaded checkpoint still forks from that head.
