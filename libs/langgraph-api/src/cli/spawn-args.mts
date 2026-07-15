import { isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { StartServerOptions } from "../server.mjs";

/** Default loader: tsx CLI with built-in watch. */
export const DEFAULT_NODE_LOADER = "tsx";

type LoaderRegistration = {
  specifier: string;
  flag: "--loader" | "--import";
};

/**
 * Shorthand loader names mapped to Node registration hooks.
 * Use `"tsx"` (not `"tsx/esm"`) to spawn via the tsx CLI instead.
 *
 * `ts-node` uses `--loader` (not `--import`) because `ts-node/esm` is a
 * custom ESM loader hook. Node 20+ deprecates `--loader` in favor of
 * `module.register()`, but ts-node still documents this entrypoint.
 */
export const LOADER_REGISTRATIONS: Record<string, LoaderRegistration> = {
  "ts-node": { specifier: "ts-node/esm", flag: "--loader" },
  "ts-node/esm": { specifier: "ts-node/esm", flag: "--loader" },
};

export function resolveNodeLoader(
  configLoader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const envLoader = env.LANGGRAPH_NODE_LOADER?.trim();
  if (envLoader) return envLoader;
  return configLoader ?? DEFAULT_NODE_LOADER;
}

export function resolveLoaderRegistration(
  loader: string,
  resolve: (specifier: string) => string
): LoaderRegistration & { path: string } {
  const registration = LOADER_REGISTRATIONS[loader] ?? {
    specifier: loader,
    flag: "--import" as const,
  };

  const path = resolveLoaderPath(registration.specifier, loader, resolve);

  return { ...registration, path };
}

export function resolveLoaderPath(
  specifier: string,
  loader: string,
  resolve: (specifier: string) => string
): string {
  if (specifier.startsWith("file://")) {
    return fileURLToPath(specifier);
  }
  if (isAbsolute(specifier)) {
    return specifier;
  }

  try {
    return fileURLToPath(new URL(resolve(specifier)));
  } catch {
    const hint =
      loader === "ts-node" || loader.startsWith("ts-node/")
        ? ' Install "ts-node" and enable "emitDecoratorMetadata" in tsconfig when using reflect-metadata.'
        : "";
    throw new Error(
      `node_loader "${loader}" could not be resolved.${hint} Install the package or provide a valid module specifier, file path, or file:// URL.`
    );
  }
}

/** Convert a resolved filesystem path to a Node `--loader`/`--import` URL. */
export function toNodeModuleUrl(path: string): string {
  if (path.startsWith("file://")) return path;
  return pathToFileURL(path).href;
}

export function usesTsxCli(loader: string): boolean {
  return loader === DEFAULT_NODE_LOADER;
}

export function buildSpawnArgs(options: {
  nodeLoader: string;
  reload: boolean;
  pid: number;
  payload: StartServerOptions;
  resolve: (specifier: string) => string;
}): { command: string; args: string[] } {
  const payloadArg = JSON.stringify(options.payload);
  const sharedArgs = [options.pid.toString(), payloadArg] as const;
  const preloadUrl = new URL(options.resolve("../preload.mjs")).toString();
  const entrypointPath = fileURLToPath(
    new URL(options.resolve("./entrypoint.mjs"))
  );

  if (usesTsxCli(options.nodeLoader)) {
    const args = [
      fileURLToPath(new URL("../../cli.mjs", options.resolve("tsx/esm/api"))),
      ...(options.reload ? ["watch"] : []),
      "--clear-screen=false",
      "--import",
      preloadUrl,
      entrypointPath,
      ...sharedArgs,
    ];

    return { command: process.execPath, args };
  }

  const loader = resolveLoaderRegistration(options.nodeLoader, options.resolve);
  const args = [
    ...(options.reload ? ["--watch"] : []),
    loader.flag,
    toNodeModuleUrl(loader.path),
    "--import",
    preloadUrl,
    entrypointPath,
    ...sharedArgs,
  ];

  return { command: process.execPath, args };
}
