// This is the Jest config used by the test harness when being executed via the CLI.
// For the Jest config for the tests in this project, see the `jest.config.cjs` in the root of the package workspace.
const path = require("path");

/** @type {import('ts-jest').JestConfigWithTsJest} */
const config = {
  preset: "ts-jest/presets/default-esm",
  rootDir: path.resolve(__dirname, "..", "dist"),
  testEnvironment: "node",
  testMatch: ["<rootDir>/runner.js"],
  transform: {
    "^.+\\.(ts|js)x?$": ["@swc/jest"],
  },
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.[jt]sx?$": "$1",
  },
  maxWorkers: "50%",
};

module.exports = config;
