---
"@langchain/langgraph-sdk": patch
---

fix(sdk): ignore prior-run protocol replay after hydrate submit

New SSE subscriptions replay the thread tape from seq=0. Without a
run-scoped filter, an older run's `lifecycle: completed` can settle the
first submit and replayed `values` can rewind UI state. Gate root
lifecycle/values/pause on durable `run_id` (envelope or synth fallback).

Closes #2609
