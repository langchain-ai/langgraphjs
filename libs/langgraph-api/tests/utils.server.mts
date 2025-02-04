// run the server for CLI

import { startServer } from "../src/server.mjs";
import * as url from "node:url";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "../src/logging.mjs";

const configPath = url.fileURLToPath(
  new URL("./graphs/langgraph.json", import.meta.url)
);

const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
const cwd = path.dirname(configPath);

if (typeof config.env === "object" && config.env !== null) {
  Object.assign(process.env, config.env);
} else {
  throw new Error("env file not supported by test server");
}

const server = await startServer({
  port: 2024,
  nWorkers: 1,
  host: "localhost",
  cwd,
  graphs: config.graphs,
});

logger.info(`Server running at ${server.host}`);
