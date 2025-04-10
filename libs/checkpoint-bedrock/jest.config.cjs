/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  testEnvironment: "./jest.env.cjs",
  modulePathIgnorePatterns: ["dist/"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["@swc/jest"],
  },
  transformIgnorePatterns: [
    "/node_modules/",
    "\\.pnp\\.[^\\/]+$",
    "./scripts/jest-setup-after-env.js",
  ],
  setupFiles: ["dotenv/config"],
  testTimeout: 100_000,
  passWithNoTests: true,
};
