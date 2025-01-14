#!/bin/bash
set -e # Exit on error
set -x # Print commands before execution

pnpm run build
rm -rf tests/graphs/.langgraph_api
npx -y concurrently -n "server,test" -k -s "command-1" \
  "node dist/cli/cli.mjs dev --no-browser --config ./tests/graphs/langgraph.json" \
  "npx -y wait-port -t 3000 localhost:9123 && pnpm run test run"
