---
"@langchain/langgraph-cli": patch
---

A bare major or major.minor `api_version` (for example `"0.18"`) now resolves to the newest final `langgraph-api` release in that line on PyPI before the base image is chosen, so `build`, `up`, `dockerfile` and `deploy` use a tag that is published. Exact versions and prereleases are used as written, and `deploy --base-image` skips the lookup. If PyPI can't be reached, pin an exact version such as `"0.18.3"`.
