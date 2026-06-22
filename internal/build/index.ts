import { resolve, extname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type Format, type UserConfig } from "tsdown";
import type { PackageJson } from "type-fest";
import type { Options as UnusedOptions } from "unplugin-unused";

import { findWorkspacePackages } from "./utils.js";
import type { CompilePackageOptions } from "./types.js";

/**
 * Re-exported so packages can author a type-safe `tsdown.config.ts` with their
 * build overrides without depending on `tsdown` directly (mirroring how
 * langchainjs packages import build helpers from `@langchain/build`).
 */
export { defineConfig } from "tsdown";

const __dirname = fileURLToPath(import.meta.url);
const root = resolve(__dirname, "..", "..", "..");

export async function compilePackages(opts: CompilePackageOptions) {
  const packages = await findWorkspacePackages(root, opts);
  if (packages.length === 0) {
    const query = opts.packageQuery
      ? `matching "${opts.packageQuery}"`
      : "with no package query";
    throw new Error(`No packages found ${query}!`);
  }

  await Promise.all(
    packages.map(({ pkg, path }) => buildProject(path, pkg, opts))
  );
}

async function buildProject(
  path: string,
  pkg: PackageJson,
  opts: CompilePackageOptions
) {
  const input = Object.entries(pkg.exports || {}).filter(
    ([exp]) => !extname(exp)
  ) as [string, PackageJson.ExportConditions][];
  const entry = input.map(([, { input }]) => input).filter(Boolean) as string[];
  const watch = opts.watch ?? false;
  const sourcemap = !opts.skipSourcemap;
  const exportsCJS = Object.values(pkg.exports || {}).some(
    (exp) => typeof exp === "object" && exp && "require" in exp
  );
  const format: Format[] = exportsCJS ? ["esm", "cjs"] : ["esm"];

  /**
   * Per-package build overrides. Packages may ship a `tsdown.config.{ts,mts,js,mjs}`
   * that exports a partial tsdown config (mirroring the langchainjs convention).
   * This is merged on top of the defaults below, which lets a package opt into,
   * for example, `noExternal` to bundle pure-ESM dependencies (`p-retry`,
   * `p-queue`) into the output so the CJS artifact doesn't `require()` an ESM
   * module and crash CJS consumers on Node < 20.19 / < 22.12.
   */
  const packageConfig = await loadPackageConfig(path);

  /**
   * don't clean if we:
   * - user passes `--skipClean` or
   * - have watch mode enabled (it would confuse the IDE due to missing type for a short moment)
   * - if `--noEmit` is enabled (we don't want to clean previous builds if we're not emitting anything)
   */
  const clean = !opts.skipClean && !watch && !opts.noEmit;

  /**
   * generate type declarations if not disabled
   */
  const dts = !opts.noEmit
    ? {
        parallel: true,
        cwd: path,
        sourcemap,
        tsgo: true,
      }
    : false;

  /**
   * if there are no entrypoints, skip the package
   */
  if (entry.length === 0) {
    return;
  }

  /**
   * build checks to run, automatically disabled if watch is enabled
   */
  const buildChecks = {
    unused:
      // oxlint-disable-next-line no-constant-condition
      !watch && !opts.skipUnused && false
        ? ({
            root: path,
            level: "error" as const,
          } as UnusedOptions)
        : false,
    attw: {
      profile: (exportsCJS ? "node16" : "esm-only") as "node16" | "esm-only",
      level: "error" as const,
    },
    /**
     * skip publint if:
     * - watch is enabled, to avoid running publint on every change
     * - noEmit is enabled, as not emitting types fails this check
     */
    publint:
      !watch && !opts.noEmit
        ? ({
            level: "error" as const,
            strict: true,
          } as const)
        : false,
  };

  await build({
    entry,
    clean,
    cwd: path,
    // We discover and merge the package's `tsdown.config.*` ourselves (see
    // `loadPackageConfig`) so its imports resolve from the package directory.
    // Disable tsdown's own config auto-discovery to avoid loading it twice.
    config: false,
    dts,
    sourcemap,
    unbundle: true,
    fixedExtension: false,
    inlineOnly: false,
    platform: "node",
    target: "es2022",
    outDir: "./dist",
    format,
    watch,
    tsconfig: resolve(path, "tsconfig.json"),
    ignoreWatch: [`${path}/.turbo`, `${path}/dist`, `${path}/node_modules`],
    inputOptions: {
      cwd: path,
    },
    ...buildChecks,
    ...packageConfig,
  });
}

const PACKAGE_CONFIG_FILES = [
  "tsdown.config.ts",
  "tsdown.config.mts",
  "tsdown.config.js",
  "tsdown.config.mjs",
];

/**
 * Load a package's optional `tsdown.config.*` file and return its exported
 * config (resolving a default export and any factory function). Returns an
 * empty object when the package does not ship a config.
 */
async function loadPackageConfig(path: string): Promise<Partial<UserConfig>> {
  const configFile = PACKAGE_CONFIG_FILES.map((file) =>
    resolve(path, file)
  ).find((file) => existsSync(file));
  if (!configFile) return {};

  const mod = (await import(pathToFileURL(configFile).href)) as {
    default?: unknown;
  };
  const exported = mod.default ?? mod;
  const resolved = typeof exported === "function" ? await exported() : exported;
  return (resolved as Partial<UserConfig>) ?? {};
}
