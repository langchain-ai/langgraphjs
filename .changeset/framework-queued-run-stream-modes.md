---
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

Runs queued by `submit()` while another run is streaming now request the same stream modes as a direct submit, so queued replies stream token by token instead of arriving in one piece.
