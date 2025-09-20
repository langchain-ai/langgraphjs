#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";
import { version } from "./utils/version.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { createNew } from "./index.mjs";

const program = new Command()
  .name("create-langgraph")
  .version(version)
  .description("Create a new LangGraph project")
  .argument("[path]", "Path to create the project")
  .option("-t, --template <template>", "Template to use", "")
  .hook("preAction", withAnalytics())
  .action((path, options) => {
    createNew(path, options.template).catch((error) => {
      console.error("Error:", error.message);
      process.exit(1);
    });
  });

program.parse();
