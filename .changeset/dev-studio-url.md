---
"@langchain/langgraph-cli": patch
---

Add `--studio-url` to `langgraphjs dev`, so the printed and auto-opened Studio link can point at a self-hosted LangSmith instance instead of `https://smith.langchain.com`. The flag takes precedence over the host derived from `LANGSMITH_ENDPOINT`, matching the Python CLI, and is forwarded when `dev` serves a Python project.
