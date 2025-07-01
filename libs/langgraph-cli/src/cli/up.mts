import { builder } from "./utils/builder.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfig } from "../utils/config.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { logger } from "../utils/logging.mjs";
import { createCompose, getDockerCapabilities } from "../docker/compose.mjs";
import { configToCompose, getBaseImage } from "../docker/docker.mjs";
import { getExecaOptions } from "../docker/shell.mjs";
import { $ } from "execa";
import { createHash } from "node:crypto";
import dedent from "dedent";
import { withAnalytics } from "./utils/analytics.mjs";
import { gracefulExit } from "exit-hook";

const sha256 = (input: string) =>
  createHash("sha256").update(input).digest("hex");

const getProjectName = (configPath: string) => {
  const cwd = path.dirname(configPath).toLocaleLowerCase();
  return `${path.basename(cwd)}-${sha256(cwd)}`;
};

const stream = <T extends { spawnargs: string[] }>(proc: T): T => {
  logger.debug(`Running "${proc.spawnargs.join(" ")}"`);
  return proc;
};

const waitForHealthcheck = async (port: number) => {
  const now = Date.now();
  while (Date.now() - now < 10_000) {
    const ok = await fetch(`http://localhost:${port}/ok`).then(
      (res) => res.ok,
      () => false
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    if (ok) return true;
  }

  throw new Error("Healthcheck timed out");
};

builder
  .command("up")
  .description("Launch LangGraph API server.")
  .option("-c, --config <path>", "Path to configuration file", process.cwd())
  .option(
    "-d, --docker-compose <path>",
    "Advanced: Path to docker-compose.yml file with additional services to launch"
  )
  .option("-p, --port <port>", "Port to run the server on", "8123")
  .option("--recreate", "Force recreate containers and volumes", false)
  .option(
    "--no-pull",
    "Running the server with locally-built images. By default LangGraph will pull the latest images from the registry"
  )
  .option("--watch", "Restart on file changes", false)
  .option(
    "--wait",
    "Wait for services to start before returning. Implies --detach",
    false
  )
  .option(
    "--postgres-uri <uri>",
    "Postgres URI to use for the database. Defaults to launching a local database"
  )
  .exitOverride((error) => gracefulExit(error.exitCode))
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      port: command.opts().port !== "8123",
      postgres_uri: !!command.opts().postgresUri,
      docker_compose: !!command.opts().dockerCompose,
      recreate: command.opts().recreate,
      pull: command.opts().pull,
      watch: command.opts().watch,
      wait: command.opts().wait,
    }))
  )
  .action(async (params) => {
    logger.info("Starting LangGraph API server...");
    logger.warn(
      dedent`
        For local dev, requires env var LANGSMITH_API_KEY with access to LangGraph Cloud closed beta.
        For production use, requires a license key in env var LANGGRAPH_CLOUD_LICENSE_KEY.
      `
    );

    const configPath = await getProjectPath(params.config);
    const config = getConfig(await fs.readFile(configPath, "utf-8"));

    const cwd = path.dirname(configPath);
    const capabilities = await getDockerCapabilities();

    const fullRestartFiles = [configPath];
    if (typeof config.env === "string") {
      fullRestartFiles.push(path.resolve(cwd, config.env));
    }

    const { apiDef } = await configToCompose(configPath, config, {
      watch: capabilities.watchAvailable,
    });

    const name = getProjectName(configPath);
    const execOpts = await getExecaOptions({
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exec = $(execOpts);

    if (!config._INTERNAL_docker_tag && params.pull) {
      // pull the image
      logger.info(`Pulling image ${getBaseImage(config)}...`);
      await stream(exec`docker pull ${getBaseImage(config)}`);
    }

    // remove dangling images
    logger.info(`Pruning dangling images...`);
    await stream(
      exec`docker image prune -f --filter ${`label=com.docker.compose.project=${name}`}`
    );

    // remove stale containers
    logger.info(`Pruning stale containers...`);
    await stream(
      exec`docker container prune -f --filter ${`label=com.docker.compose.project=${name}`}`
    );

    const input = createCompose(capabilities, {
      port: +params.port,
      postgresUri: params.postgresUri,
      apiDef,
    });

    const args: string[] = ["--remove-orphans"];
    if (params.recreate) {
      args.push("--force-recreate", "--renew-anon-volumes");
      try {
        await stream(exec`docker volume rm langgraph-data`);
      } catch (e) {
        // ignore
      }
    }

    if (params.watch) {
      if (capabilities.watchAvailable) {
        args.push("--watch");
      } else {
        logger.warn(
          "Watch mode is not available. Please upgrade your Docker Engine."
        );
      }
    } else if (params.wait) {
      args.push("--wait");
    } else {
      args.push("--abort-on-container-exit");
    }

    logger.info(`Launching docker-compose...`);
    const cmd =
      capabilities.composeType === "plugin"
        ? ["docker", "compose"]
        : ["docker-compose"];
    cmd.push("--project-directory", cwd, "--project-name", name);

    const userCompose = params.dockerCompose || config.docker_compose_file;
    if (userCompose) cmd.push("-f", userCompose);
    cmd.push("-f", "-");

    const up = stream($({ ...execOpts, input })`${cmd} up ${args}`);
    waitForHealthcheck(+params.port).then(
      () => {
        logger.info(`
          Ready!
          - API: http://localhost:${params.port}
          - Docs: http://localhost:${params.port}/docs
          - LangGraph Studio: https://smith.langchain.com/studio/?baseUrl=http://127.0.0.1:${params.port}
        `);
      },
      () => void 0
    );

    await up.catch(() => void 0);
  });
