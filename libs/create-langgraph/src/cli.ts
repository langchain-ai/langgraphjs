#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";

import { version } from "./utils/version.js";
import { withAnalytics } from "./utils/analytics.js";
import { createNew } from "./index.js";
import { generateConfig } from "./config.js";

const program = new Command()
  .name("create-langgraph")
  .version(version)
  .description("Create a new LangGraph project");

// Default command: create a new project
program
  .argument("[path]", "Path to create the project")
  .option("-t, --template <template>", "Template to use", "")
  .hook("preAction", withAnalytics())
  .action((path, options) => {
    createNew(path, options.template).catch((error) => {
      console.error("Error:", error.message);
      process.exit(1);
    });
  });

// Config subcommand: generate langgraph.json
program
  .command("config")
  .description(
    "Generate a langgraph.json configuration file by scanning for agents"
  )
  .argument("[path]", "Path to the project to scan (defaults to current directory)")
  .hook("preAction", withAnalytics())
  .action((path) => {
    generateConfig(path).catch((error) => {
      console.error("Error:", error.message);
      process.exit(1);
    });
  });

program.parse();
