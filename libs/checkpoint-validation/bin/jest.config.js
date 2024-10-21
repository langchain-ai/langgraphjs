// This is the Jest config used by the test harness when being executed via the CLI.
// For the Jest config for the tests in this project, see the `jest.config.cjs` in the root of the package workspace.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../dist/parse_args.js";

const args = await parseArgs(process.argv.slice(2));

/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: "ts-jest/presets/default-esm",
  rootDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist"),
  testEnvironment: "node",
  testMatch: ["<rootDir>/runner.js"],
  transform: {
    "^.+\\.[jt]sx?$": ["@swc/jest"],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.[jt]sx?$": "$1",
  },
  globals: args,
};
