---
"@langchain/langgraph-sdk": patch
---

`StreamOrchestrator` shows the interrupts of a thread it loads only after the load has looked for a run still going on that thread, so they show a request or two later than before. When the load found a run in progress, that run's `{ when: "breakpoint" }` placeholder, or an interrupt it had already answered, showed until the join started. Headless tools waiting in the loaded state run after that lookup too, so a reload during a resumed tool run no longer runs the tool again. The lookup gives up after 10 seconds, and `respond()` with no id waits for it. An interrupt already on screen stays shown while `hydrate()` reads the thread again, and a run started during a load shows its interrupts without waiting for the lookup.
