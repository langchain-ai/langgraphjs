import { Command } from "@commander-js/extra-typings";
import { version } from "./version.mjs";

export const builder = new Command()
  .name("langgraph")
  .description("LangGraph.js CLI")
  .version(version)
  .enablePositionalOptions();
