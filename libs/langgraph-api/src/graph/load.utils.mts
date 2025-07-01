import type { CompiledGraph, Graph } from "@langchain/langgraph";
import * as uuid from "uuid";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const GRAPHS: Record<string, CompiledGraph<string>> = {};
export const NAMESPACE_GRAPH = uuid.parse(
  "6ba7b821-9dad-11d1-80b4-00c04fd430c8"
);

export type CompiledGraphFactory<T extends string> = (config: {
  configurable?: Record<string, unknown>;
}) => Promise<CompiledGraph<T>>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence?: false }
): Promise<{
  sourceFile: string;
  exportSymbol: string;
  resolved: CompiledGraph<string> | CompiledGraphFactory<string>;
}>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence: true }
): Promise<{ sourceFile: string; exportSymbol: string; resolved: undefined }>;

export async function resolveGraph(
  spec: string,
  options: { cwd: string; onlyFilePresence?: boolean }
) {
  const [userFile, exportSymbol] = spec.split(":", 2);
  const sourceFile = path.resolve(options.cwd, userFile);

  // validate file exists
  await fs.stat(sourceFile);
  if (options?.onlyFilePresence) {
    return { sourceFile, exportSymbol, resolved: undefined };
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
