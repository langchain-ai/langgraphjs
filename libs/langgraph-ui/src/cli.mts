#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";
import * as api from "./api.mjs";

const builder = new Command().name("langgraphjs-ui");

builder
  .command("build")
  .requiredOption("-o, --output <string>", "Output directory")
  .action(api.build);

builder
  .command("watch")
  .requiredOption("-o, --output <string>", "Output directory")
  .action(api.watch);

builder.parse();
