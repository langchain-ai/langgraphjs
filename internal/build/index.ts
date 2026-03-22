import { resolve, extname, dirname } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type Format } from "tsdown";
import type { PackageJson } from "type-fest";
import type { Options as UnusedOptions } from "unplugin-unused";

import { findWorkspacePackages } from "./utils.js";
import type { CompilePackageOptions } from "./types.js";

const __dirname = fileURLToPath(import.meta.url);
const root = resolve(__dirname, "..", "..", "..");

/**
 * Rolldown plugin that compiles `.svelte.ts` / `.svelte.js` modules
 * via the Svelte compiler's `compileModule` API. This enables the use
 * of Svelte 5 runes (`$state`, `$derived`, `$effect`, …) in library
 * source files without requiring the full Vite Svelte plugin.
 *
 * The plugin uses `resolveId` + `load` to remap `.svelte.ts` source
 * files to clean module IDs (without `.svelte`), so that rolldown
 * outputs plain `.js` / `.cjs` files that downstream Svelte Vite
 * plugins won't attempt to re-compile.
 *
 * TypeScript is stripped first via `ts.transpileModule`, then the
 * result is passed through `svelte/compiler.compileModule`.
 */
async function svelteModulePlugin(packagePath: string) {
  const svelteCompilerUrl = pathToFileURL(
    resolve(packagePath, "node_modules", "svelte", "compiler", "index.js"),
  ).href;
  const typescriptUrl = pathToFileURL(
    resolve(packagePath, "node_modules", "typescript", "lib", "typescript.js"),
  ).href;

  type CompileModule = (
    source: string,
    options: { filename: string; generate: string },
  ) => { js: { code: string; map: unknown } };

  const svelteCompiler = await import(svelteCompilerUrl);
  const compileModule: CompileModule =
    svelteCompiler.compileModule ?? svelteCompiler.default?.compileModule;

  const tsModule = await import(typescriptUrl);
  const ts = (tsModule.default ?? tsModule) as typeof import("typescript");

  const svelteModuleIds = new Set<string>();

  return {
    name: "svelte-module",

    resolveId(source: string, importer: string | undefined) {
      if (!importer || !source.includes(".svelte.")) return null;

      const importerDir = dirname(importer);
      const svelteTsPath = resolve(
        importerDir,
        source.replace(/\.js$/, ".ts"),
      );
      const cleanId = svelteTsPath.replace(/\.svelte\.ts$/, ".ts");

      svelteModuleIds.add(cleanId);
      return cleanId;
    },

    load(id: string) {
      if (!svelteModuleIds.has(id)) return null;

      const svelteFile = id.replace(/\.ts$/, ".svelte.ts");
      return readFileSync(svelteFile, "utf8");
    },

    transform(code: string, id: string) {
      if (!svelteModuleIds.has(id)) return null;

      const svelteFile = id.replace(/\.ts$/, ".svelte.ts");

      const stripped = ts.transpileModule(code, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
        fileName: svelteFile,
      });

      const result = compileModule(stripped.outputText, {
        filename: svelteFile,
        generate: "client",
      });
      return { code: result.js.code, map: result.js.map };
    },
  };
}

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

  const plugins: Awaited<ReturnType<typeof svelteModulePlugin>>[] = [];
  if (
    (pkg.peerDependencies && "svelte" in pkg.peerDependencies) ||
    (pkg.dependencies && "svelte" in pkg.dependencies)
  ) {
    plugins.push(await svelteModulePlugin(path));
  }

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
