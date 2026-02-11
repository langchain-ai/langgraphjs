---
"@langchain/langgraph-cli": patch
---

Support `api_version` field in `langgraph.json` to control the base Docker image tag. When set, the image tag becomes `{api_version}-node{node_version}` (e.g., `langchain/langgraphjs-api:0.7.29-node22`) instead of just `{node_version}`.
