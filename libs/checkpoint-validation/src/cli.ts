import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@jest/core";

import { parseArgs } from "./parse_args.js";

export async function main() {
  const moduleDirname = dirname(fileURLToPath(import.meta.url));

  // parse here to check for errors before running Jest
  await parseArgs(process.argv.slice(2));

  await runCLI(
    {
      _: [],
      $0: "",
      runInBand: true,
    },
    [pathResolve(moduleDirname, "runtime_jest_config.js")]
  );
}
