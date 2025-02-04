#!/bin/bash
set -e # Exit on error
set -x # Print commands before execution

rm -rf tests/graphs/.langgraph_api
npx -y concurrently -n "server,test" -k -s "command-1" \
  "tsx ./tests/utils.server.mts" \
  "npx -y wait-port -t 3000 localhost:2024 && vitest run"