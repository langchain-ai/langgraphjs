import {
  assembleLocalDeps,
  configToCompose,
  configToDocker,
} from "../docker/docker.mjs";
import { createCompose, getDockerCapabilities } from "../docker/compose.mjs";
import { getConfig } from "../utils/config.mjs";
import { getProjectPath } from "./utils/project.mjs";
import { builder } from "./utils/builder.mjs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

builder
  .command("dockerfile")
  .description(
    "Generate a Dockerfile for the LangGraph API server, with Docker Compose options."
  )
  .argument("<save-path>", "Path to save the Dockerfile")
  .option(
    "--add-docker-compose",
    "Add additional files for running the LangGraph API server with docker-compose. These files include a docker-compose.yml, .env file, and a .dockerignore file."
  )
  .option("-c, --config <path>", "Path to configuration file", process.cwd())
  .action(async (savePath, options) => {
    const configPath = await getProjectPath(options.config);
    const config = getConfig(await fs.readFile(configPath, "utf-8"));

    const localDeps = await assembleLocalDeps(configPath, config);
    const dockerfile = await configToDocker(configPath, config, localDeps);

    if (savePath === "-") {
      console.log(dockerfile);
      return;
    }

    const targetPath = path.resolve(process.cwd(), savePath, "Dockerfile");
    await fs.writeFile(targetPath, dockerfile);

    if (options.addDockerCompose) {
      const { apiDef } = await configToCompose(configPath, config, {
        watch: false,
      });

      const capabilities = await getDockerCapabilities();
      const compose = createCompose(capabilities, { apiDef });

      const composePath = path.resolve(
        process.cwd(),
        savePath,
        "docker-compose.yml"
      );

      await fs.writeFile(composePath, compose);

      // TODO: add .dockerignore and .env files
    }
  });
