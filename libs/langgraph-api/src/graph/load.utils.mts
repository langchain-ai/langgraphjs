import { Worker } from "node:worker_threads";
import * as fs from "node:fs/promises";
import type { CompiledGraph, Graph } from "@langchain/langgraph";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as uuid from "uuid";
import type { JSONSchema7 } from "json-schema";

export const GRAPHS: Record<string, CompiledGraph<string>> = {};
export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8",
);

export interface GraphSchema {
  state: JSONSchema7 | undefined;
  input: JSONSchema7 | undefined;
  output: JSONSchema7 | undefined;
  config: JSONSchema7 | undefined;
}

export interface GraphSpec {
  sourceFile: string;
  exportSymbol: string;
}

export type CompiledGraphFactory<T extends string> = (config: {
  configurable?: Record<string, unknown>;
}) => Promise<CompiledGraph<T>>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence?: false },
): Promise<{
  sourceFile: string;
  exportSymbol: string;
  resolved: CompiledGraph<string> | CompiledGraphFactory<string>;
}>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence: true },
): Promise<{ sourceFile: string; exportSymbol: string; resolved: undefined }>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence?: boolean },
) {
  const [userFile, exportSymbol] = spec.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  // validate file exists
  await fs.stat(sourceFile);
  if (options?.onlyFilePresence) {
    return { sourceFile: userFile, exportSymbol, resolved: undefined };
  }

  type GraphLike = CompiledGraph<string> | Graph<string>;

  type GraphUnknown =
    | GraphLike
    | Promise<GraphLike>
    | ((config: {
        configurable?: Record<string, unknown>;
      }) => GraphLike | Promise<GraphLike>)
    | undefined;

  const isGraph = (graph: GraphLike): graph is Graph<string> => {
    if (typeof graph !== "object" || graph == null) return false;
    return "compile" in graph && typeof graph.compile === "function";
  };

  const graph: GraphUnknown = await import(
    pathToFileURL(sourceFile).toString()
  ).then((module) => module[exportSymbol || "default"]);

  // obtain the graph, and if not compiled, compile it
  const resolved: CompiledGraph<string> | CompiledGraphFactory<string> =
    await (async () => {
      if (!graph) throw new Error("Failed to load graph: graph is nullush");

      const afterResolve = (graphLike: GraphLike): CompiledGraph<string> => {
        const graph = isGraph(graphLike) ? graphLike.compile() : graphLike;
        return graph;
      };

      if (typeof graph === "function") {
        return async (config: { configurable?: Record<string, unknown> }) => {
          const graphLike = await graph(config);
          return afterResolve(graphLike);
        };
      }

      return afterResolve(await graph);
    })();

  return { sourceFile, exportSymbol, resolved };
}

export async function runGraphSchemaWorker(
  spec: GraphSpec,
  options?: { mainThread?: boolean },
) {
  let SCHEMA_RESOLVE_TIMEOUT_MS = 30_000;
  try {
    const envTimeout = Number.parseInt(
      process.env.LANGGRAPH_SCHEMA_RESOLVE_TIMEOUT_MS ?? "0",
      10,
    );
    if (!Number.isNaN(envTimeout) && envTimeout > 0) {
      SCHEMA_RESOLVE_TIMEOUT_MS = envTimeout;
    }
  } catch {
    // ignore
  }

  if (options?.mainThread) {
    const { SubgraphExtractor } = await import("./parser/parser.mjs");
    return SubgraphExtractor.extractSchemas(
      spec.sourceFile,
      spec.exportSymbol,
      { strict: false },
    );
  }

  return await new Promise<Record<string, GraphSchema>>((resolve, reject) => {
    const worker = new Worker(
      fileURLToPath(new URL("./parser/parser.worker.mjs", import.meta.url)),
      { argv: process.argv.slice(-1) },
    );

    // Set a timeout to reject if the worker takes too long
    const timeoutId = setTimeout(() => {
      worker.terminate();
      reject(new Error("Schema extract worker timed out"));
    }, SCHEMA_RESOLVE_TIMEOUT_MS);

    worker.on("message", (result) => {
      worker.terminate();
      clearTimeout(timeoutId);
      resolve(result);
    });

    worker.on("error", reject);
    worker.postMessage(spec);
  });
}
