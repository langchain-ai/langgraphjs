import { Command } from "@commander-js/extra-typings";

export const builder = new Command()
  .name("langgraph")
  .description("LangGraph.js CLI")
  .version("0.0.0-preview.3");
