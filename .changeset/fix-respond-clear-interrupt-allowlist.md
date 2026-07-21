---
"@langchain/langgraph-sdk": patch
---

fix(sdk): clear hydrate interrupt allowlist on respond()

`submit()` already cleared `#hydratedActiveInterruptIds` so a new run's live `input.requested` events were not dropped as historical. `respond()` / `respondAll()` (via `dispatchResume`) did not, so a follow-on HITL after resume never appeared on `stream.interrupt` and free-text submits could resume with the wrong payload.
