// run the server for CLI
import { spawnServer } from "../src/cli/spawn.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "dotenv";

const configPath = fileURLToPath(
  new URL("./graphs/langgraph.json", import.meta.url),
);
const config = JSON.parse(await readFile(configPath, "utf-8"));

let env = {} as NodeJS.ProcessEnv;
if (typeof config.env === "string") {
  const targetEnvFile = resolve(dirname(configPath), config.env);
  env = parse(await readFile(targetEnvFile, "utf-8")) as NodeJS.ProcessEnv;
} else if (config.env != null) {
  env = config.env;
}

await spawnServer(
  { port: "2024", nJobsPerWorker: "10", host: "localhost" },
  { config, env, hostUrl: "https://smith.langchain.com" },
  { pid: process.pid, projectCwd: dirname(configPath) },
);
