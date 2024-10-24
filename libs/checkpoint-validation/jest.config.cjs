/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest/presets/default-esm",
  rootDir: "../../",
  testEnvironment: "./libs/checkpoint-validation/jest.env.cjs",
  testMatch: ["<rootDir>/libs/checkpoint-validation/src/**/*.spec.ts"],
  modulePathIgnorePatterns: ["dist/"],
  
  collectCoverageFrom: [
    "<rootDir>/libs/checkpoint/src/memory.ts",
    "<rootDir>/libs/checkpoint-mongodb/src/index.ts",
    "<rootDir>/libs/checkpoint-postgres/src/index.ts",
    "<rootDir>/libs/checkpoint-sqlite/src/index.ts",
    "<rootDir>/libs/checkpoint-supabase/src/index.ts",
  ],
  
  coveragePathIgnorePatterns: [
    ".+\\.(test|spec)\\.ts",
  ],
  
  coverageDirectory: "<rootDir>/libs/checkpoint-validation/coverage",

  moduleNameMapper: {
    "^@langchain/langgraph-(checkpoint(-[^/]+)?)$": "<rootDir>/libs/$1/src/index.ts",
    "^@langchain/langgraph-(checkpoint(-[^/]+)?)/(.+)\\.js$": "<rootDir>/libs/$1/src/$2.ts",
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  transform: {
    "^.+\\.tsx?$": ["@swc/jest"],
  },
  transformIgnorePatterns: [
    "/node_modules/(?!@langchain/langgraph-checkpoint-[^/]+)",
    "\\.pnp\\.[^\\/]+$",
    "./scripts/jest-setup-after-env.js",
  ],
  setupFiles: ["dotenv/config"],
  testTimeout: 20_000,
  passWithNoTests: true,
};
