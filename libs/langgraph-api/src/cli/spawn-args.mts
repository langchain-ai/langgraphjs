import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

/** Default loader: tsx CLI with built-in watch. */
export const DEFAULT_NODE_LOADER = "tsx";

/**
 * Shorthand loader names mapped to Node `--import` specifiers.
 * Use `"tsx"` (not `"tsx/esm"`) to spawn via the tsx CLI instead.
 */
export const LOADER_IMPORT_SHORTCUTS: Record<string, string> = {
  "ts-node": "ts-node/esm",
};

export type SpawnServerPayload = {
  port: number;
  nWorkers: number;
  host: string;
  graphs: Record<string, string | { path: string; description?: string }>;
  auth?: {
    path?: string;
    disable_studio_auth?: boolean;
  };
  ui?: Record<string, string>;
  ui_config?: { shared?: string[] };
  cwd: string;
  http?: {
    app?: string;
    disable_assistants?: boolean;
    disable_threads?: boolean;
    disable_runs?: boolean;
    disable_store?: boolean;
    disable_meta?: boolean;
    cors?: {
      allow_origins?: string[];
      allow_methods?: string[];
      allow_headers?: string[];
      allow_credentials?: boolean;
      allow_origin_regex?: string;
      expose_headers?: string[];
      max_age?: number;
    };
  };
};

export function resolveNodeLoader(
  configLoader: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): string {
  const envLoader = env.LANGGRAPH_NODE_LOADER?.trim();
  if (envLoader) return envLoader;
  return configLoader ?? DEFAULT_NODE_LOADER;
}

export function resolveLoaderImport(
  loader: string,
  resolve: (specifier: string) => string
): string {
  const specifier = LOADER_IMPORT_SHORTCUTS[loader] ?? loader;

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

export function usesTsxCli(loader: string): boolean {
  return loader === DEFAULT_NODE_LOADER;
}

export function buildSpawnArgs(options: {
  nodeLoader: string;
  reload: boolean;
  pid: number;
  payload: SpawnServerPayload;
  resolve: (specifier: string) => string;
}): { command: string; args: string[] } {
  const payloadArg = JSON.stringify(options.payload);
  const sharedArgs = [options.pid.toString(), payloadArg] as const;

  if (usesTsxCli(options.nodeLoader)) {
    const args = [
      fileURLToPath(
        new URL("../../cli.mjs", options.resolve("tsx/esm/api"))
      ),
      ...(options.reload ? ["watch"] : []),
      "--clear-screen=false",
      "--import",
      new URL(options.resolve("../preload.mjs")).toString(),
      fileURLToPath(new URL(options.resolve("./entrypoint.mjs"))),
      ...sharedArgs,
    ];

    return { command: process.execPath, args };
  }

  const loaderImport = resolveLoaderImport(options.nodeLoader, options.resolve);
  const args = [
    ...(options.reload ? ["--watch"] : []),
    "--import",
    loaderImport,
    "--import",
    fileURLToPath(new URL(options.resolve("../preload.mjs"))),
    fileURLToPath(new URL(options.resolve("./entrypoint.mjs"))),
    ...sharedArgs,
  ];

  return { command: process.execPath, args };
}
