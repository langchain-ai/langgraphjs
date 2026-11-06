---
"@langchain/langgraph-sdk": minor
"@langchain/react": minor
"@langchain/vue": minor
"@langchain/svelte": minor
"@langchain/angular": minor
---

feat(sdk): add `subgraphs: false` to `useStream`, which loads the thread from `GET /threads/{thread_id}` and never reads `/state` or `/history`
