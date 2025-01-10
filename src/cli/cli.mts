import { Command } from "commander";
import { startServer } from "../server.mjs";
import open from "open";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { ConfigSchema } from "../utils/config.mjs";
import { logger } from "../logging.mjs";
import * as dotenv from "dotenv";

const program = new Command();

program
  .name("langgraph-api")
  .description("LangGraph API development server")
  .version("0.0.1")
  .option("-p, --port <number>", "port to run the server on", "9123")
  .option("-h, --host <string>", "host to bind to", "localhost")
  .option("--no-browser", "disable auto-opening the browser")
  .option("-n, --n-jobs-per-worker <number>", "number of workers to run", "10")
  .option("-c, --config <path>", "path to config file")
  .action(async (options) => {
    try {
      const configPath = options.config
        ? path.resolve(process.cwd(), options.config)
        : path.resolve(process.cwd(), "langgraph.json");

      const config = ConfigSchema.parse(
        JSON.parse(await fs.readFile(configPath, "utf-8"))
      );

      const cwd = path.dirname(configPath);

      if (config?.env) {
        const env = config?.env;
        if (typeof env === "string") {
          dotenv.config({ path: path.resolve(cwd, env) });
        } else if (Array.isArray(env)) {
          throw new Error("Env storage is not supported by CLI.");
        } else if (typeof env === "object") {
          if (!process.env) throw new Error("process.env is not defined");

          // @ts-expect-error
          dotenv.populate(process.env, env);
        }
      }

      // Start the server
      const serverUrl = await startServer({
        port: Number.parseInt(options.port, 10),
        nWorkers: Number.parseInt(options.nJobsPerWorker, 10),
        host: options.host,
        config,
        cwd,
      });

      logger.info(`Server running at ${serverUrl}`);
      if (options.browser) await open(serverUrl);
    } catch (error) {
      logger.error(error);
    }
  });

program.parse();
