import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { webdriverio } from "@vitest/browser-webdriverio";

/**
 * The side-by-side tests run 1.x's hooks as main has them, at the main commit
 * `react-2.0` last merged, so both sides run on this branch's SDK.
 */
function extractMainHooks() {
  const commitFile = new URL("./src/tests/parity/main-commit.txt", import.meta.url);
  const commit = readFileSync(commitFile, "utf8").trim();
  const dir = fileURLToPath(new URL("./.parity-v1/", import.meta.url));
  const marker = join(dir, ".commit");
  if (existsSync(marker) && readFileSync(marker, "utf8") === commit) return;

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: fileURLToPath(new URL(".", import.meta.url)),
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    git("cat-file", "-e", `${commit}^{commit}`);
  } catch {
    git("fetch", "--depth=1", "origin", commit);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Run from this package, so the archive's paths start at `src/`.
  execFileSync(
    "tar",
    ["-x", "--strip-components=1", "--exclude=src/tests", "-C", dir],
    { input: git("archive", commit, "--", "src") }
  );
  writeFileSync(marker, commit);
}

extractMainHooks();

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    browser: {
      enabled: true,
      connectTimeout: 120_000,
      provider: webdriverio(),
      instances: [{ browser: "chrome", headless: true }],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/*.test.tsx"],
          exclude: ["**/*.test-d.ts"],
          testTimeout: 5_000,
          retry: 1,
          typecheck: {
            enabled: true,
            include: ["**/*.test-d.ts"],
            tsconfig: "./tsconfig.typecheck.json",
          },
        },
      },
      {
        extends: true,
        test: {
          name: "parity",
          include: ["src/tests/parity/*.test.tsx"],
          globalSetup: ["./src/tests/server.ts"],
          // The graphs' scripted models count turns across the server.
          fileParallelism: false,
          testTimeout: 60_000,
          retry: 0,
        },
      },
    ],
  },
});
