---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

Back the stream controller's enqueue strategy with protocol run.start acceptance, run-ID-correlated observation, paginated pending-run hydration, and server cancellation. Preserve stable queue keys and message IDs, detach accepted runs on thread switches, and require an explicit serverQueue observation/cancellation capability with matching transport authentication. Track running and pending runs separately, reconcile delayed acceptance, and resume subscriptions even when the lifecycle watcher sees a queued run first. Preserve ordinary stream-only submits.
