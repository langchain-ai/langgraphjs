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

  const isCompiledGraph = (
    graph: GraphLike
  ): graph is CompiledGraph<string> => {
    if (typeof graph !== "object" || graph == null) return false;
    return (
      "builder" in graph &&
      typeof graph.builder === "object" &&
      graph.builder != null
    );
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

        // TODO: hack, remove once LangChain 1.x createAgent is fixed.
        // `createAgent` returns a ReactAgent wrapper that itself looks
        // like a CompiledGraph (it has a `builder` — the outer
        // StateGraph) *and* exposes the real compiled pregel under
        // `.graph`. Unwrap to the inner graph whenever both are
        // present so downstream code (e.g. the v2 streaming path that
        // keys off `graph.streamTransformers`) sees the actual pregel
        // rather than the wrapper.
        const inner = (graph as { graph?: unknown }).graph;
        if (
          inner != null &&
          typeof inner === "object" &&
          isCompiledGraph(inner as GraphLike)
        ) {
          return inner as CompiledGraph<string>;
        }
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
