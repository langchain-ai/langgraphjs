import type {
  InteropZodObject,
  InferInteropZodOutput,
} from "@langchain/core/utils/types";

import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import type {
  StateSchema,
  StateSchemaInit,
  InferStateSchemaValue,
  InferStateSchemaUpdate,
} from "../state/index.js";
import type {
  AnnotationRoot,
  StateDefinition,
  StateType,
  UpdateType as AnnotationUpdateType,
} from "./annotation.js";
import type { UpdateType as ZodUpdateType } from "./zod/meta.js";
import type { Send } from "../constants.js";
import { END, Command } from "../constants.js";

// Re-export END for use in ConditionalEdgeRouter return types
export { END };

/**
 * Extract the State type from any supported schema type.
 *
 * Supports:
 * - StateSchema
 * - AnnotationRoot
 * - StateDefinition (internal channel definitions)
 * - InteropZodObject (Zod v3/v4 object schemas)
 *
 * @template Schema - The schema type to extract state from
 * @template Fallback - Type to return if schema doesn't match (default: never)
 */
export type ExtractStateType<
  Schema,
  Fallback = Schema
> = Schema extends StateSchema<infer TInit extends StateSchemaInit>
  ? InferStateSchemaValue<TInit>
  : Schema extends AnnotationRoot<infer SD extends StateDefinition>
  ? StateType<SD>
  : Schema extends StateDefinition
  ? StateType<Schema>
  : Schema extends InteropZodObject
  ? InferInteropZodOutput<Schema>
  : Fallback;

/**
 * Extract the Update type from any supported schema type.
 *
 * The Update type represents what a node can return to update the state.
 * All fields are optional since nodes only need to return the fields they modify.
 *
 * Supports:
 * - StateSchema
 * - AnnotationRoot
 * - StateDefinition (internal channel definitions)
 * - InteropZodObject (Zod v3/v4 object schemas)
 *
 * @template Schema - The schema type to extract update type from
 * @template Fallback - Type to return if schema doesn't match (default: never)
 */
export type ExtractUpdateType<
  Schema,
  Fallback = never
> = Schema extends StateSchema<infer TInit extends StateSchemaInit>
  ? InferStateSchemaUpdate<TInit>
  : Schema extends AnnotationRoot<infer SD extends StateDefinition>
  ? AnnotationUpdateType<SD>
  : Schema extends StateDefinition
  ? AnnotationUpdateType<Schema>
  : Schema extends InteropZodObject
  ? ZodUpdateType<Schema>
  : Fallback;

/**
 * Utility type for typing graph nodes outside of the StateGraph builder.
 *
 * This type allows you to define node functions with full type safety
 * before adding them to a graph, improving code organization and editor support.
 *
 * Works with StateSchema, AnnotationRoot, and Zod object schemas.
 *
 * @template Schema - The state schema type (StateSchema, AnnotationRoot, or InteropZodObject)
 * @template Nodes - Optional union of valid node names for Command.goto (default: string)
 * @template Config - Optional custom config type extending LangGraphRunnableConfig
 *
 * @example
 * ```typescript
 * import { StateSchema, GraphNode } from "@langchain/langgraph";
 * import { z } from "zod/v4";
 *
 * const AgentState = new StateSchema({
 *   messages: MessagesValue,
 *   step: z.number().default(0),
 * });
 *
 * // Simple node - just returns state update
 * const processNode: GraphNode<typeof AgentState> = (state, config) => {
 *   return { step: state.step + 1 };
 * };
 *
 * // Node with typed Command routing
 * const routerNode: GraphNode<typeof AgentState, "agent" | "tool"> = (state) => {
 *   if (state.needsTool) {
 *     return new Command({ goto: "tool", update: { step: state.step + 1 } });
 *   }
 *   return new Command({ goto: "agent" });
 * };
 *
 * // Use in graph
 * const graph = new StateGraph(AgentState)
 *   .addNode("process", processNode)
 *   .addNode("router", routerNode)
 *   .compile();
 * ```
 */
export type GraphNode<
  Schema,
  Nodes extends string = string,
  Config extends LangGraphRunnableConfig = LangGraphRunnableConfig
> = (
  state: ExtractStateType<Schema>,
  config: Config
) =>
  | ExtractUpdateType<Schema>
  | Command<unknown, ExtractUpdateType<Schema>, Nodes>
  | Promise<
      | ExtractUpdateType<Schema>
      | Command<unknown, ExtractUpdateType<Schema>, Nodes>
    >;

/**
 * Type for conditional edge routing functions.
 *
 * Use this to type functions passed to `addConditionalEdges` for
 * full type safety on state access and return values.
 *
 * @template Schema - The state schema type
 * @template Nodes - Union of valid node names that can be routed to
 *
 * @example
 * ```typescript
 * const router: ConditionalEdgeRouter<typeof AgentState, "agent" | "tool" | "__end__"> =
 *   (state) => {
 *     if (state.done) return END;
 *     return state.needsTool ? "tool" : "agent";
 *   };
 *
 * graph.addConditionalEdges("router", router, ["agent", "tool"]);
 * ```
 */
export type ConditionalEdgeRouter<Schema, Nodes extends string> = (
  state: ExtractStateType<Schema>
) =>
  | Nodes
  | typeof END
  | Send<Nodes, ExtractStateType<Schema>>
  | Array<Nodes | Send<Nodes, ExtractStateType<Schema>>>;
