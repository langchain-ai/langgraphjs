---
"@langchain/langgraph-api": minor
"@langchain/langgraph-cli": minor
"@langchain/langgraph-ui": minor
---

feat(langgraph-cli): add `deploy` command for LangSmith Deployment

Port the Python CLI's `langgraph deploy` workflow to `@langchain/langgraph-cli`, including local and remote build paths, deployment lifecycle subcommands (`list`, `revisions list`, `delete`, `logs`), and host-backend client utilities with tests.
