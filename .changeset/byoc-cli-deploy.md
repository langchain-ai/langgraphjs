---
"@langchain/langgraph-cli": minor
---

`langgraphjs deploy` and its `list`, `revisions list`, `logs` and `delete` subcommands work on LangSmith BYOC data planes with only an API key. The CLI finds the key's workspace through the LangSmith API, sends requests to that workspace's data plane, and links status pages to the LangSmith UI. On a data plane, it checks before creating anything that CLI builds (and, for `prod`, dedicated deployments) are supported. `--host-url` now defaults to the discovered host and still overrides it; a `--host-url` that ends in a data plane's `/api-host` gets the same checks. The CLI only sends the API key to an `https` data plane, and asks for the workspace when the key's workspaces are on different planes and `LANGSMITH_TENANT_ID` is unset.
