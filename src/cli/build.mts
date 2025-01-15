import { builder } from "./utils/builder.mjs";

builder
  .command("build")
  .description("Build LangGraph API server Docker image.")
  .option("-t, --tag <tag>", "Tag for the Docker image.")
  .option("-c, --config <path>", "Path to configuration file")
  .option(
    "--no-pull",
    "Running the server with locally-built images, by default LangGraph will pull the latest images from the registry"
  )
  .action(async () => {
    throw new Error("Not implemented");
  });
