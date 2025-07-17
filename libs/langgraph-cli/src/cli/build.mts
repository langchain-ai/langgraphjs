import { getDockerCapabilities } from "../docker/compose.mjs";
import {
  assembleLocalDeps,
  configToDocker,
  getBaseImage,
} from "../docker/docker.mjs";
import { getExecaOptions } from "../docker/shell.mjs";
import { getConfig } from "../utils/config.mjs";
import { builder } from "./utils/builder.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { $ } from "execa";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { logger } from "../utils/logging.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { gracefulExit } from "exit-hook";
const stream = <T extends { spawnargs: string[] }>(proc: T): T => {
  logger.info(`Running "${proc.spawnargs.join(" ")}"`);
  return proc;
};

builder
  .command("build")
  .description("Build LangGraph API server Docker image.")
  .requiredOption("-t, --tag <tag>", "Tag for the Docker image.")
  .option("-c, --config <path>", "Path to configuration file", process.cwd())
  .option(
    "--no-pull",
    "Running the server with locally-built images. By default LangGraph will pull the latest images from the registry"
  )
  .argument("[args...]")
  .passThroughOptions()
  .allowUnknownOption()
  .exitOverride((error) => gracefulExit(error.exitCode))
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      pull: command.opts().pull,
    }))
  )
  .action(async (pass, params) => {
    const configPath = await getProjectPath(params.config);
    await getDockerCapabilities();

    const projectDir = path.dirname(configPath);
    const config = getConfig(await fs.readFile(configPath, "utf-8"));

    const opts = await getExecaOptions({
      cwd: projectDir,
      stderr: "inherit",
      stdout: "inherit",
    });

    const localDeps = await assembleLocalDeps(configPath, config);
    const input = await configToDocker(configPath, config, localDeps, {
      watch: false,
      dockerCommand: "build",
    });

    let exec = $({ ...opts, input });
    if (params.pull) {
      await stream(exec`docker pull ${getBaseImage(config)}`);
    }

    exec = $({ ...opts, input });
    await stream(
      exec`docker build -f - -t ${params.tag} ${projectDir} ${pass}`
    );
  });
