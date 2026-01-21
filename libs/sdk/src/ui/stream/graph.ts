/**
 * Stream types for CompiledStateGraph and Pregel instances.
 *
 * This module provides the stream interface for graphs compiled with
 * `new StateGraph(...).compile()` or Pregel instances.
 *
 * @module
 */

import type { BagTemplate } from "../../types.template.js";
import type { DefaultToolCall } from "../../types.messages.js";
import type { UseStreamOptions, NodeStream } from "../types.js";
import type { BaseStream } from "./base.js";

/**
 * Helper type to look up a node's return type from the NodeReturnTypes map.
 * Falls back to Record<string, unknown> if the node name isn't in the map.
 */
type LookupNodeValues<
  NodeReturnTypes extends Record<string, Record<string, unknown>>,
  N extends string
> = N extends keyof NodeReturnTypes
  ? NodeReturnTypes[N] extends Record<string, unknown>
    ? NodeReturnTypes[N]
    : Record<string, unknown>
  : Record<string, unknown>;

/**
 * Stream interface for CompiledStateGraph and Pregel instances.
 *
 * Use this when streaming from a graph compiled with `new StateGraph(...).compile()`.
 * This interface provides core streaming capabilities without tool-specific features,
 * plus type-safe node streaming for tracking individual node executions.
 *
 * For tool calling capabilities, use {@link UseAgentStream} with `createAgent`.
 * For subagent streaming, use {@link UseDeepAgentStream} with `createDeepAgent`.
 *
 * @template StateType - The graph's state type (inferred from `~RunOutput` or `~OutputType`)
 * @template ToolCall - Tool call type (defaults to `DefaultToolCall`)
 * @template Bag - Type configuration bag for interrupts, configurable, etc.
 * @template NodeName - Union of node names in the graph (inferred from `~NodeType`)
 * @template NodeReturnTypes - Map of node names to their return types (inferred from `~NodeReturnType`)
 *
 * @example
 * ```typescript
 * import { StateGraph, Annotation } from "@langchain/langgraph";
 * import { useStream } from "@langchain/langgraph-sdk/react";
 *
 * // Define your state
 * const StateAnnotation = Annotation.Root({
 *   messages: Annotation<Message[]>({ reducer: (a, b) => [...a, ...b] }),
 *   data: Annotation<string>(),
 * });
 *
 * // Create and compile the graph
 * const graph = new StateGraph(StateAnnotation)
 *   .addNode("researcher", researcherFn)
 *   .addNode("writer", writerFn)
 *   .addNode("reviewer", reviewerFn)
 *   .compile();
 *
 * // In React component:
 * function Chat() {
 *   const stream = useStream<typeof graph>({
 *     assistantId: "my-graph",
 *     apiUrl: "http://localhost:2024",
 *   });
 *
 *   // Type-safe state access
 *   // stream.values is typed as { messages: Message[]; data: string }
 *
 *   // Type-safe node streaming with per-node value types
 *   const researcherNodes = stream.getNodeStreamsByName("researcher");
 *   const latestRun = researcherNodes[researcherNodes.length - 1];
 *   if (latestRun) {
 *     console.log(latestRun.name);      // "researcher" (typed literal)
 *     console.log(latestRun.values);    // Typed to researcher's return type
 *     console.log(latestRun.isLoading); // boolean
 *     console.log(latestRun.messages);  // Messages from this node
 *     console.log(latestRun.update);    // State update from this node
 *   }
 * }
 * ```
 *
 * @remarks
 * This interface does NOT include:
 * - `toolCalls` / `getToolCalls` - Use {@link UseAgentStream} for tool calling
 * - `subagents` / `getSubagentsByType` - Use {@link UseDeepAgentStream} for subagent streaming
 *
 * These properties are intentionally omitted because CompiledStateGraph does not
 * have built-in tool calling or subagent concepts. If you need these features,
 * use `createAgent` or `createDeepAgent` instead.
 */
export interface UseGraphStream<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  ToolCall = DefaultToolCall,
  Bag extends BagTemplate = BagTemplate,
  NodeName extends string = string,
  NodeReturnTypes extends Record<string, Record<string, unknown>> = Record<
    string,
    Record<string, unknown>
  >
> extends BaseStream<StateType, ToolCall, Bag> {
  // ==========================================================================
  // Node Streaming
  // ==========================================================================

  /**
   * All node executions, keyed by unique execution ID.
   *
   * Each entry represents a single execution of a node. If a node runs
   * multiple times (e.g., in a loop), each execution has its own entry.
   * The key is a unique execution ID (e.g., `"researcher:1:1234567890"`),
   * while the node name is available via `nodeStream.name`.
   *
   * @example
   * ```typescript
   * // Iterate over all executions
   * for (const [executionId, nodeStream] of stream.nodes) {
   *   console.log(`Node ${nodeStream.name} (${executionId})`);
   *   console.log(`  Status: ${nodeStream.status}`);
   *   console.log(`  Messages: ${nodeStream.messages.length}`);
   * }
   *
   * // Or convert to array for rendering
   * const nodeList = Array.from(stream.nodes.values());
   * ```
   */
  nodes: Map<string, NodeStream<NodeName>>;

  /**
   * Currently active nodes (where status === "running").
   *
   * Use this to display loading indicators or track which nodes are
   * currently processing.
   *
   * @example
   * ```typescript
   * stream.activeNodes.forEach(node => {
   *   console.log(`${node.name} is currently running...`);
   * });
   * ```
   */
  activeNodes: NodeStream<NodeName>[];

  /**
   * Get a specific node execution by its unique execution ID.
   *
   * @param executionId - The unique execution ID
   * @returns The node stream, or undefined if not found
   *
   * @example
   * ```typescript
   * const node = stream.getNodeStream("researcher:1:1234567890");
   * if (node) {
   *   console.log(`Node ${node.name}: ${node.status}`);
   * }
   * ```
   */
  getNodeStream: (executionId: string) => NodeStream<NodeName> | undefined;

  /**
   * Get all executions of a specific node by name.
   *
   * Returns all executions in chronological order (oldest first).
   * Useful for nodes that run multiple times in a workflow.
   *
   * The returned `NodeStream` objects are typed with:
   * - The specific node name passed in (as a literal type)
   * - The node's return type for `values` (inferred from `~NodeReturnType`)
   *
   * @param nodeName - The name of the node (type-safe when graph is typed)
   * @returns Array of all executions of that node, with typed name and values
   *
   * @example
   * ```typescript
   * // Get all executions of the "researcher" node
   * const researcherRuns = stream.getNodeStreamsByName("researcher");
   *
   * researcherRuns.forEach((run, index) => {
   *   console.log(`Execution ${index + 1}:`);
   *   console.log(`  Name: ${run.name}`);   // typed as "researcher"
   *   console.log(`  Values: ${run.values}`); // typed to researcher's return type
   *   console.log(`  Messages: ${run.messages.length}`);
   *   console.log(`  Update: ${JSON.stringify(run.update)}`);
   * });
   * ```
   */
  getNodeStreamsByName: <N extends NodeName>(
    nodeName: N
  ) => NodeStream<N, LookupNodeValues<NodeReturnTypes, N>>[];
}

/**
 * Options for configuring a graph stream.
 *
 * Use this options interface when calling `useStream` with a CompiledStateGraph.
 * Extends the full {@link UseStreamOptions} with all configuration options.
 *
 * @template StateType - The graph's state type
 * @template Bag - Type configuration bag
 *
 * @example
 * ```typescript
 * const stream = useStream<typeof graph>({
 *   assistantId: "my-graph",
 *   apiUrl: "http://localhost:2024",
 *   threadId: "thread-123", // optional
 *   messagesKey: "messages",
 *   onError: (error) => console.error(error),
 *   onFinish: (state) => console.log("Completed:", state),
 * });
 * ```
 */
export interface UseGraphStreamOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
> extends UseStreamOptions<StateType, Bag> {
  // Graph-specific options can be added here in the future.
  // Currently inherits all options from UseStreamOptions.
}
