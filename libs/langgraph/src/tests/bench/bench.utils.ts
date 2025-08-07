import { randomUUID } from "crypto";
import { gatherIterator } from "../../utils.js";
import type { CompiledStateGraph } from "../../graph/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStateGraph = CompiledStateGraph<any, any, any, any, any, any>;

/**
 * Comprehensive LangGraph.js Performance Benchmarks
 *
 * This file contains all the performance benchmarks ported from the Python version.
 * Based on langgraph/libs/langgraph/bench/__main__.py
 */
// Helper functions
export const runGraph = async (
  graph: AnyStateGraph,
  input: Record<string, unknown>
) => {
  const results = await gatherIterator(
    graph.stream(input, {
      configurable: { thread_id: randomUUID() },
      recursionLimit: 1000000000,
    })
  );
  return results.length;
};

export const runFirstEventLatency = async (
  graph: AnyStateGraph,
  input: Record<string, unknown>
) => {
  const iterator = await graph.stream(input, {
    configurable: { thread_id: randomUUID() },
    recursionLimit: 1000000000,
  });
  await iterator.next();
};
