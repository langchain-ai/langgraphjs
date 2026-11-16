// Runs outside vitest because `spawnServer` needs `import.meta.resolve`,
// which vite's module runner doesn't have.
import { spawnServer } from "@langchain/langgraph-api";

const [port, cwd, graphs] = process.argv.slice(2);
const server = await spawnServer(
  { host: "127.0.0.1", port, nJobsPerWorker: "10", reload: false },
  { config: { graphs: JSON.parse(graphs) }, env: process.env, hostUrl: "" },
  { pid: process.pid, projectCwd: cwd }
);
for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => server.kill(signal));
}
server.once("exit", (code) => process.exit(code ?? 0));
