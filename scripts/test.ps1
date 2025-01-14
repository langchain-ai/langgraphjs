Set-PSDebug -Trace 1
$ErrorActionPreference = "Stop"

pnpm run build

Remove-Item -Path "tests/graphs/.langgraph_api" -Recurse -Force -ErrorAction SilentlyContinue
npx -y concurrently -n "server,test" -k -s "command-1" `
  "node dist/cli/cli.mjs dev --no-browser --config ./tests/graphs/langgraph.json" `
  "npx -y wait-port -t 3000 localhost:9123 && vitest run"
