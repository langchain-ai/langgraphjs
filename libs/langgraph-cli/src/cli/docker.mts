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
import dedent from "dedent";
import { logger } from "../utils/logging.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { gracefulExit } from "exit-hook";

const fileExists = async (path: string) => {
  try {
    await fs.access(path);
    return true;
  } catch (e) {
    return false;
  }
};

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
  .exitOverride((error) => gracefulExit(error.exitCode))
  .hook(
    "preAction",
    withAnalytics((command) => ({
      config: command.opts().config !== process.cwd(),
      add_docker_compose: !!command.opts().addDockerCompose,
    }))
  )
  .action(async (savePath, options) => {
    const configPath = await getProjectPath(options.config);
    const config = getConfig(await fs.readFile(configPath, "utf-8"));

    const localDeps = await assembleLocalDeps(configPath, config);
    const dockerfile = await configToDocker(configPath, config, localDeps);

    if (savePath === "-") {
      process.stdout.write(dockerfile);
      process.stdout.write("\n");
      return;
    }

    const targetPath = path.resolve(process.cwd(), savePath);
    await fs.writeFile(targetPath, dockerfile);
    logger.info(`✅ Created: ${path.basename(targetPath)}`);

    if (options.addDockerCompose) {
      const { apiDef } = await configToCompose(configPath, config, {
        watch: false,
      });

      const capabilities = await getDockerCapabilities();
      const compose = createCompose(capabilities, { apiDef });

      const composePath = path.resolve(
        path.dirname(targetPath),
        "docker-compose.yml"
      );

      await fs.writeFile(composePath, compose);
      logger.info("✅ Created: .docker-compose.yml");

      const dockerignorePath = path.resolve(
        path.dirname(targetPath),
        ".dockerignore"
      );

      if (!fileExists(dockerignorePath)) {
        await fs.writeFile(
          dockerignorePath,
          dedent`
            # Ignore node_modules and other dependency directories
            node_modules
            bower_components
            vendor
  
            # Ignore logs and temporary files
            *.log
            *.tmp
            *.swp
  
            # Ignore .env files and other environment files
            .env
            .env.*
            *.local
  
            # Ignore git-related files
            .git
            .gitignore
  
            # Ignore Docker-related files and configs
            .dockerignore
            docker-compose.yml
  
            # Ignore build and cache directories
            dist
            build
            .cache
            __pycache__
  
            # Ignore IDE and editor configurations
            .vscode
            .idea
            *.sublime-project
            *.sublime-workspace
            .DS_Store  # macOS-specific
  
            # Ignore test and coverage files
            coverage
            *.coverage
            *.test.js
            *.spec.js
            tests
          `
        );
        logger.info(`✅ Created: ${path.basename(dockerignorePath)}`);
      }

      const envPath = path.resolve(path.dirname(targetPath), ".env");
      if (!fileExists(envPath)) {
        await fs.writeFile(
          envPath,
          dedent`
            # Uncomment the following line to add your LangSmith API key
            # LANGSMITH_API_KEY=your-api-key
            # Or if you have a LangSmith Deployment license key, then uncomment the following line:
            # LANGGRAPH_CLOUD_LICENSE_KEY=your-license-key
            # Add any other environment variables go below...
          `
        );
        logger.info(`✅ Created: ${path.basename(envPath)}`);
      }
    }
  });
