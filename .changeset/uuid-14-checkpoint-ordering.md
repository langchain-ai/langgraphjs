---
"@examples/chatbot-simulation-evaluation": patch
"@examples/chatbots": patch
"@examples/how-tos": patch
"@examples/multi_agent": patch
"@examples/plan-and-execute": patch
"@examples/quickstart": patch
"@examples/rag": patch
"@examples/reflection": patch
"@examples/rewoo": patch
"@langchain/langgraph-checkpoint-redis": patch
"@langchain/langgraph-checkpoint": patch
"@langchain/langgraph-api": patch
"@langchain/langgraph": patch
"@langchain/langgraph-supervisor": patch
"@langchain/langgraph-sdk": patch
---

chore(deps): bump uuid to 14.0.0 and fix checkpoint ID ordering

Bump `uuid` from 10.x/13.x to 14.0.0 across packages. uuid 14 no longer preserves sort order between negative and positive `clockseq` values in v6 UUIDs, which broke checkpoint listing. Use non-negative clockseq values for `emptyCheckpoint()` and update tests accordingly.
