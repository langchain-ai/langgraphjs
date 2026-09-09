---
"@langchain/langgraph-sdk": patch
---

fix(sdk): coalesce locally resolved interrupts

when resolving interrupts using `useStream`, there was a case where we prioritized the remote state values (which we lookup in React Strict mode on every page transition) over the local interrupt responses we know we've responded with.

This has since been fixed to first prioritize the local cache of interrupts, resolved against the remote state values when a run hits a terminal event
