---
"@langchain/langgraph-sdk": patch
"@langchain/react": patch
"@langchain/vue": patch
"@langchain/svelte": patch
"@langchain/angular": patch
---

fix(sdk): resume useChannel subscriptions across serial runs

Enable `resumeOnPause` on the channel projection so `useChannel` keeps
accumulating events across prompts on the same thread. Clarify selector
docs and JSDoc: `useChannel` for the full event stream, `useExtension`
for the latest payload.
