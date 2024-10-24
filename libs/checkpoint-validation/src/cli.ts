import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCLI } from "@jest/core";
import type { Config } from "@jest/types";

import { validateArgs } from "./parse_args.js";

const rootDir = pathResolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist"
);
const config: Config.Argv = {
  _: [pathResolve(rootDir, "runner.js")],
  $0: "",
  preset: "ts-jest/presets/default-esm",
  rootDir,
  testEnvironment: "node",
  testMatch: ["<rootDir>/runner.js"],
  transform: JSON.stringify({
    "^.+\\.[jt]sx?$": "@swc/jest",
  }),
  moduleNameMapper: JSON.stringify({
    "^(\\.{1,2}/.*)\\.[jt]sx?$": "$1",
  }),

  // jest ignores test files in node_modules by default. We want to run a test file that ships with this package, so
  // we disable that behavior here.
  testPathIgnorePatterns: [],
  haste: JSON.stringify({
    retainAllFiles: true,
  }),
};

export async function main() {
  // check for argument errors before running Jest
  await validateArgs(process.argv.slice(2));

  await runCLI(config, [rootDir]);
}
