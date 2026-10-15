---
"@langchain/langgraph-cli": patch
---

`langgraphjs deploy` local builds push through your active Docker context. Before, the push used a temporary Docker config with no current context and failed with `failed to connect to the docker API at unix:///var/run/docker.sock` on setups like Docker Desktop without the default socket. An explicit `DOCKER_HOST` is still respected.
