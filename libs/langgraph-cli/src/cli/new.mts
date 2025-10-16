#!/usr/bin/env node
import { builder } from "./utils/builder.mjs";
import { withAnalytics } from "./utils/analytics.mjs";
import { createNew } from "create-langgraph";
import { gracefulExit } from "exit-hook";

builder
  .command("new")
  .description("Create a new LangGraph project")
  .argument("[path]", "Path to create the project")
  .option("-t, --template <template>", "Template to use", "")
  .hook("preAction", withAnalytics())
  .exitOverride((error) => gracefulExit(error.exitCode))
  .action((path, options) => createNew(path, options.template));
