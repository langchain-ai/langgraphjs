import * as path from "node:path";
import * as fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ChildProcess } from "node:child_process";

import { spawn } from "node:child_process";
import open from "open";
import * as dotenv from "dotenv";

import { logger } from "../logging.mjs";
import { ConfigSchema } from "../utils/config.mjs";
import { createIpcServer } from "./utils/ipc/server.mjs";
import { z } from "zod";
import { watch } from "chokidar";
import { builder } from "./utils/builder.mjs";
import { getProjectPath } from "./utils/project.mjs";

const tsxTarget = new URL("../../cli.mjs", import.meta.resolve("tsx/esm/api"));
const entrypointTarget = new URL(import.meta.resolve("./dev.entrypoint.mjs"));

builder
  .command("dev")
  .description(
    "Run LangGraph API server in development mode with hot reloading."
  )
  .option("-p, --port <number>", "port to run the server on", "2024")
  .option("-h, --host <string>", "host to bind to", "localhost")
  .option("--no-browser", "disable auto-opening the browser")
  .option("-n, --n-jobs-per-worker <number>", "number of workers to run", "10")
  .option("-c, --config <path>", "path to configuration file", process.cwd())
  .action(async (options) => {
    try {
      const configPath = await getProjectPath(options.config);
      const projectCwd = path.dirname(configPath);
      const [pid, server] = await createIpcServer();
      const watcher = watch([configPath], {
        ignoreInitial: true,
        cwd: projectCwd,
      });

      let hasOpenedFlag = false;
      let child: ChildProcess | undefined = undefined;

      const localUrl = `http://${options.host}:${options.port}`;
      const studioUrl = `https://smith.langchain.com/studio?baseUrl=${
        localUrl
      }`;

      console.log(
        `
         Welcome to

╦  ┌─┐┌┐┌┌─┐╔═╗┬─┐┌─┐┌─┐┬ ┬
║  ├─┤││││ ┬║ ╦├┬┘├─┤├─┘├─┤
╩═╝┴ ┴┘└┘└─┘╚═╝┴└─┴ ┴┴  ┴ ┴.js

- 🚀 API: \x1b[36m${localUrl}\x1b[0m
- 🎨 Studio UI: \x1b[36m${studioUrl}\x1b[0m

This in-memory server is designed for development and testing.
For production use, please use LangGraph Cloud.

`
      );

      server.on("data", (data) => {
        const { host } = z.object({ host: z.string() }).parse(data);
        logger.info(`Server running at ${host}`);

        if (options.browser && !hasOpenedFlag) {
          hasOpenedFlag = true;

          open(studioUrl);
        }
      });

      // check if .gitignore already contains .langgraph-api
      const gitignorePath = path.resolve(projectCwd, ".gitignore");
      const gitignoreContent = await fs
        .readFile(gitignorePath, "utf-8")
        .catch(() => "");

      if (!gitignoreContent.includes(".langgraph_api")) {
        logger.info(
          "Updating .gitignore to prevent `.langgraph_api` from being committed."
        );
        await fs.appendFile(
          gitignorePath,
          "\n# LangGraph API\n.langgraph_api\n"
        );
      }

      const prepareContext = async () => {
        const config = ConfigSchema.parse(
          JSON.parse(await fs.readFile(configPath, "utf-8"))
        );
        const newWatch = [configPath];
        const env = { ...process.env } as NodeJS.ProcessEnv;
        const configEnv = config?.env;

        if (configEnv) {
          if (typeof configEnv === "string") {
            const envPath = path.resolve(projectCwd, configEnv);
            newWatch.push(envPath);

            const envData = await fs.readFile(envPath, "utf-8");
            dotenv.populate(
              env as Record<string, string>,
              dotenv.parse(envData)
            );
          } else if (Array.isArray(configEnv)) {
            throw new Error("Env storage is not supported by CLI.");
          } else if (typeof configEnv === "object") {
            if (!process.env) throw new Error("process.env is not defined");
            dotenv.populate(env as Record<string, string>, configEnv);
          }
        }

        const oldWatch = Object.entries(watcher.getWatched()).flatMap(
          ([dir, files]) =>
            files.map((file) => path.resolve(projectCwd, dir, file))
        );

        const addedTarget = newWatch.filter(
          (target) => !oldWatch.includes(target)
        );

        const removedTarget = oldWatch.filter(
          (target) => !newWatch.includes(target)
        );

        watcher.unwatch(removedTarget).add(addedTarget);
        return { config, env };
      };

      const launchTsx = async () => {
        const { config, env } = await prepareContext();
        if (child != null) child.kill();

        child = spawn(
          process.execPath,
          [
            fileURLToPath(tsxTarget),
            "watch",
            "--clear-screen=false",
            fileURLToPath(entrypointTarget),
            pid.toString(),
            JSON.stringify({
              port: Number.parseInt(options.port, 10),
              nWorkers: Number.parseInt(options.nJobsPerWorker, 10),
              host: options.host,
              graphs: config.graphs,
              cwd: projectCwd,
            }),
          ],
          { stdio: ["inherit", "inherit", "inherit", "ipc"], env }
        );
      };

      watcher.on("all", async (_name, path) => {
        logger.warn(`Detected changes in ${path}, restarting server`);
        launchTsx();
      });

      // TODO: handle errors
      launchTsx();

      process.on("exit", () => {
        watcher.close();
        server.close();
        child?.kill();
      });
    } catch (error) {
      logger.error(error);
    }
  });
