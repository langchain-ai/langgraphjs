import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

import { parse, populate } from "dotenv";
import { watch } from "chokidar";
import { z } from "zod";
import open from "open";

import { startCloudflareTunnel, type CloudflareTunnel } from "./cloudflare.mjs";
import { createIpcServer } from "./utils/ipc/server.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { getConfig } from "../utils/config.mjs";
import { builder } from "./utils/builder.mjs";
import { logError, logger } from "../utils/logging.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { gracefulExit } from "exit-hook";

const DEFAULT_STUDIO_URL = "https://smith.langchain.com";

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
  .option(
    "--tunnel",
    "use Cloudflare Tunnel to expose the server to the internet"
  )
  .option(
    "--studio-url",
    `URL of the LangGraph Studio instance to connect to. Defaults to ${DEFAULT_STUDIO_URL}`
  )
  .allowExcessArguments()
  .allowUnknownOption()
  .exitOverride((error) => gracefulExit(error.exitCode))
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      port: command.opts().port !== "2024",
      host: command.opts().host !== "localhost",
      n_jobs_per_worker: command.opts().nJobsPerWorker !== "10",
      tunnel: Boolean(command.opts().tunnel),
    }))
  )
  .action(async (options, { args }) => {
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
      let tunnel: CloudflareTunnel | undefined = undefined;

      let envNoBrowser = process.env.BROWSER === "none";

      server.on("data", async (data) => {
        const response = z.object({ queryParams: z.string() }).parse(data);
        if (options.browser && !envNoBrowser && !hasOpenedFlag) {
          hasOpenedFlag = true;

          const queryParams = new URLSearchParams(response.queryParams);
          const tunnelUrl = await tunnel?.tunnelUrl;
          if (tunnelUrl) queryParams.set("baseUrl", tunnelUrl);

          let queryParamsStr = queryParams.toString();
          if (queryParamsStr) queryParamsStr = `?${queryParams.toString()}`;

          open(`${hostUrl}/studio${queryParamsStr}`);
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
        const config = getConfig(await fs.readFile(configPath, "utf-8"));
        const newWatch = [configPath];
        const env = { ...process.env } as NodeJS.ProcessEnv;
        const configEnv = config?.env;

        if (configEnv) {
          if (typeof configEnv === "string") {
            const envPath = path.resolve(projectCwd, configEnv);
            newWatch.push(envPath);

            const envData = await fs.readFile(envPath, "utf-8");
            populate(env as Record<string, string>, parse(envData));
          } else if (Array.isArray(configEnv)) {
            throw new Error("Env storage is not supported by CLI.");
          } else if (typeof configEnv === "object") {
            if (!process.env) throw new Error("process.env is not defined");
            populate(env as Record<string, string>, configEnv);
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

        try {
          const { Client } = await import("langsmith");
          const apiUrl =
            env?.["LANGSMITH_ENDPOINT"] ||
            env?.["LANGCHAIN_ENDPOINT"] ||
            undefined;

          hostUrl = new Client({ apiUrl }).getHostUrl() || hostUrl;
        } catch {
          // pass
        }

        return { config, env, hostUrl };
      };

      const launchServer = async () => {
        const { config, env, hostUrl } = await prepareContext();
        if (child != null) child.kill();
        if (tunnel != null) tunnel.child.kill();
        if (options.tunnel) tunnel = await startCloudflareTunnel(options.port);
        envNoBrowser = process.env.BROWSER === "none" || env.BROWSER === "none";

        if ("python_version" in config) {
          logger.warn(
            "Launching Python server from @langchain/langgraph-cli is experimental. Please use the `langgraph-cli` package from PyPi instead."
          );

          const { spawnPythonServer } = await import("./dev.python.mjs");
          child = await spawnPythonServer(
            { ...options, rest: args },
            { configPath, config, env, hostUrl },
            { pid, projectCwd }
          );
        } else {
          const { spawnServer } = await import("@langchain/langgraph-api");
          child = await spawnServer(
            options,
            { config, env, hostUrl },
            { pid, projectCwd }
          );
        }
      };

      watcher.on("all", async (_name, path) => {
        logger.warn(`Detected changes in ${path}, restarting server`);
        launchServer();
      });

      // TODO: sometimes the server keeps sending stuff
      // while gracefully exiting
      launchServer();

      process.on("exit", () => {
        watcher.close();
        server.close();
        child?.kill();
      });
    } catch (error) {
      logError(error, { prefix: "Failed to launch server" });
    }
  });
