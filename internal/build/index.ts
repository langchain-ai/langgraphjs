import { resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

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
    packages.map(({ pkg, path }) => buildProject(path, pkg, opts)),
  );
}

async function buildProject(
  path: string,
  pkg: PackageJson,
  opts: CompilePackageOptions,
) {
  const input = Object.entries(pkg.exports || {}).filter(
    ([exp]) => !extname(exp),
  ) as [string, PackageJson.ExportConditions][];
  const entry = input.map(([, { input }]) => input).filter(Boolean) as string[];
  const watch = opts.watch ?? false;
  const sourcemap = !opts.skipSourcemap;
  const exportsCJS = Object.values(pkg.exports || {}).some(
    (exp) => typeof exp === "object" && exp && "require" in exp,
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

  /**
   * build checks to run, automatically disabled if watch is enabled
   */
  const buildChecks = {
    unused:
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

  const plugins = await getSveltePlugins(pkg, path);

  await build({
    entry,
    clean,
    cwd: path,
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
    plugins,
    ...buildChecks,
  });
}

/**
 * For packages with `svelte` as a peer dependency, add a rolldown
 * transform plugin that compiles `.svelte.ts` / `.svelte.js` modules
 * via `svelte/compiler`'s `compileModule`.
 */
/**
 * For packages with `svelte` as a peer dependency, add a rolldown
 * transform plugin that compiles `.svelte.ts` / `.svelte.js` modules
 * via `svelte/compiler`'s `compileModule`.
 */
async function getSveltePlugins(
  pkg: PackageJson,
  pkgPath: string,
): Promise<{ name: string; transform: (code: string, id: string) => unknown }[]> {
  if (!pkg.peerDependencies || !("svelte" in pkg.peerDependencies)) return [];

  try {
    const pkgRequire = createRequire(resolve(pkgPath, "package.json"));
    const svelteCompilerPath = pkgRequire.resolve("svelte/compiler");
    const esbuildPath = pkgRequire.resolve("esbuild");

    const svelteCompiler = await import(svelteCompilerPath);
    const compileModule = svelteCompiler.compileModule ?? svelteCompiler.default?.compileModule;
    const esbuildMod = await import(esbuildPath);
    const transformSync = esbuildMod.transformSync ?? esbuildMod.default?.transformSync;

    if (!compileModule || !transformSync) return [];

    return [
      {
        name: "svelte-runes",
        transform(code: string, id: string) {
          if (id.includes("node_modules")) return undefined;
          if (!id.endsWith(".svelte.ts") && !id.endsWith(".svelte.js"))
            return undefined;

          const stripped = id.endsWith(".svelte.ts")
            ? transformSync(code, {
                loader: "ts",
                format: "esm",
                target: "esnext",
              }).code
            : code;

          const result = compileModule(stripped, {
            filename: id,
            generate: "client",
          });

          return { code: result.js.code, map: result.js.map };
        },
      },
    ];
  } catch {
    return [];
  }
}
