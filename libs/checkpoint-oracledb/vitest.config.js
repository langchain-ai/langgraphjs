import { config as loadEnv } from "dotenv";
import { configDefaults, defineConfig } from "vitest/config";

const ORACLE_ENV_VARS = [
  "ORACLE_USER",
  "ORACLE_PASSWORD",
  "ORACLE_CONNECT_STRING",
];

/**
 * Integration tests skip themselves when credentials are absent, and a run
 * where every test skips still exits 0. In CI that turns a lost secret into
 * silently vanished coverage, so refuse to start instead.
 *
 * Set ALLOW_SKIPPED_ORACLE_INT_TESTS=1 to opt out, e.g. when running the
 * suite locally without a database on purpose.
 */
function requireOracleCredentials() {
  // The tests themselves read a .env, so honour it here too.
  loadEnv();
  if (process.env.ALLOW_SKIPPED_ORACLE_INT_TESTS) return;

  const missing = ORACLE_ENV_VARS.filter((name) => !process.env[name]);
  if (missing.length === 0) return;

  throw new Error(
    [
      `Integration tests need a database, but ${missing.join(", ")} ${
        missing.length === 1 ? "is" : "are"
      } not set.`,
      "Every test would skip and the run would still pass, hiding the gap.",
      "Set the variables (or put them in a .env), or re-run with",
      "ALLOW_SKIPPED_ORACLE_INT_TESTS=1 to skip on purpose.",
    ].join("\n")
  );
}

export default defineConfig((env) => {
  /** @type {import("vitest/config").UserConfigExport} */
  const common = {
    test: {
      hideSkippedTests: true,
      globals: true,
      testTimeout: 30_000,
      exclude: ["**/*.int.test.ts", "parity/**", ...configDefaults.exclude],
      passWithNoTests: true,
    },
  };

  if (env.mode === "int") {
    requireOracleCredentials();
    return {
      test: {
        ...common.test,
        minWorkers: 0.5,
        testTimeout: 100_000,
        exclude: ["parity/**", ...configDefaults.exclude],
        include: ["**/*.int.test.ts"],
        name: "int",
        environment: "node",
      },
    };
  }

  return {
    test: {
      ...common.test,
      name: "unit",
      environment: "node",
    },
  };
});