import { Command } from "@commander-js/extra-typings";

import * as fs from "node:fs/promises";
import * as url from "node:url";

export const builder = new Command()
  .name("langgraph")
  .description("LangGraph.js CLI")
  .enablePositionalOptions();

try {
  const packageJson = url.fileURLToPath(
    new URL("../../../package.json", import.meta.url)
  );
  const { version } = JSON.parse(await fs.readFile(packageJson, "utf-8"));
  builder.version(version + "+js");
} catch (error) {
  console.error(error);
  // pass
}
