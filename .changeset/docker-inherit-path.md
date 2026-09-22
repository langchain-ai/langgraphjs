---
"@langchain/langgraph-cli": patch
---

Resolve the `docker` binary from the inherited environment instead of a synthesised `PATH`, fixing `build`, `up`, `deploy` and `dockerfile --add-docker-compose` on Linux and Windows.

The CLI previously discarded the caller's `PATH` and rebuilt one, first by probing the login shell through `dscl` (macOS Directory Services) and then by falling back to a hardcoded list of macOS install locations. Both strategies originate from LangGraph Studio's desktop app, where a Finder-launched process inherits launchd's minimal environment; neither applies to a CLI invoked from a terminal or from CI.

On Linux the `dscl` probe reported success with empty output, because the missing command sat on the left of a pipe and the shell returned `sed`'s exit status. Discovery then degraded to the hardcoded list, which omits `/usr/local/bin` — where Docker's install script and most CI images place the binary — so the CLI reported "Docker is required but not installed" on machines where `docker` was installed and on `PATH`. On Windows the fallback could never succeed, since verification shelled out to `which`.

Docker is now spawned the way any other command is, so `PATH`, `DOCKER_HOST` and credential helpers all behave as the caller configured them. A missing binary is reported separately from a daemon that is not running, matching the Python CLI.
