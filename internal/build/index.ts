import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type Format } from "tsdown";
import type { PackageJson } from "type-fest";
import type { Options as UnusedOptions } from "unplugin-unused";

import { findWorkspacePackages } from "./utils.js";
import type { CompilePackageOptions } from "./types.js";

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

  const buildChecks = (runPackageChecks: boolean) => ({
    unused:
      // oxlint-disable-next-line no-constant-condition
      !watch && !opts.skipUnused && false
        ? ({
            root: path,
            level: "error" as const,
          } as UnusedOptions)
        : false,
    attw: runPackageChecks
      ? {
          profile: (exportsCJS ? "node16" : "esm-only") as
            | "node16"
            | "esm-only",
          level: "error" as const,
        }
      : false,
    /**
     * skip publint if:
     * - watch is enabled, to avoid running publint on every change
     * - noEmit is enabled, as not emitting types fails this check
     * - intermediate dual-format pass (checks run after CJS is emitted)
     */
    publint:
      runPackageChecks && !watch && !opts.noEmit
        ? ({
            level: "error" as const,
            strict: true,
          } as const)
        : false,
  });

  const sharedBuildOptions = (runPackageChecks: boolean) => ({
    entry,
    cwd: path,
    dts,
    sourcemap,
    unbundle: true as const,
    fixedExtension: false,
    platform: "node" as const,
    target: "es2022",
    outDir: "./dist",
    watch,
    tsconfig: resolve(path, "tsconfig.json"),
    ignoreWatch: [`${path}/.turbo`, `${path}/dist`, `${path}/node_modules`],
    inputOptions: {
      cwd: path,
    },
    ...buildChecks(runPackageChecks),
  });

  // uuid@12+ is ESM-only. Bundle it into CJS outputs only so require() consumers
  // (e.g. Jest) get relative .cjs copies. Keep ESM uuid external: tsx/esbuild
  // mishandle bundled default imports when loading dist/*.js in workspace packages.
  if (exportsCJS) {
    await build({
      ...sharedBuildOptions(false),
      clean,
      format: ["esm"],
    });
    await build({
      ...sharedBuildOptions(true),
      clean: false,
      format: ["cjs"],
      deps: { alwaysBundle: ["uuid"] },
    });
  } else {
    await build({ ...sharedBuildOptions(true), clean, format });
  }
}
