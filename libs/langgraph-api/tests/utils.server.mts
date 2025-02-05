// run the server for CLI
import { spawnServer } from "../src/cli/spawn.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

const configPath = fileURLToPath(
  new URL("./graphs/langgraph.json", import.meta.url),
);
const config = JSON.parse(await readFile(configPath, "utf-8"));

await spawnServer(
  {
    port: "2024",
    nJobsPerWorker: "10",
    host: "localhost",
  },
  {
    config,
    env: config.env,
    hostUrl: "https://smith.langchain.com",
  },
  { pid: process.pid, projectCwd: dirname(configPath) },
);
