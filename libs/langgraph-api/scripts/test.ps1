Set-PSDebug -Trace 1
$ErrorActionPreference = "Stop"

pnpm run build

Remove-Item -Path "tests/graphs/.langgraph_api" -Recurse -Force -ErrorAction SilentlyContinue
npx -y concurrently -n "server,test" -k -s "command-1" `
  "tsx ./tests/utils.server.mts" `
  "npx -y wait-port -t 3000 localhost:2024 && vitest run"
