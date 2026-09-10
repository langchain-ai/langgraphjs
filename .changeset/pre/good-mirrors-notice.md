---
"@langchain/langgraph-sdk": patch
---

fix(sdk): appropriately track persisted seq for stream replay

Sequences weren't being appropriately attributed when rehydrating the page (e.g. on refresh). This meant we'd lose stream information on `useStream` on reloads. This has been fixed by adding a lookup step to determine what the most appropriate sequence index is to track in the event stream.:x
