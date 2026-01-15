import type {
  InteropZodObject,
  InferInteropZodOutput,
} from "@langchain/core/utils/types";

import type { Runtime } from "../pregel/runnable_types.js";
import type { StateSchema } from "../state/index.js";
import type {
  AnnotationRoot,
  StateDefinition,
  StateType,
  UpdateType as AnnotationUpdateType,
} from "./annotation.js";
import type { UpdateType as ZodUpdateType } from "./zod/meta.js";
import type { CommandInstance, Send } from "../constants.js";
import { END } from "../constants.js";

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
> = Schema extends StateSchema<infer _TInit>
  ? Schema["State"]
  : Schema extends AnnotationRoot<infer SD>
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
  Fallback = Partial<Schema>
> = Schema extends StateSchema<infer _TInit>
  ? Schema["Update"]
  : Schema extends AnnotationRoot<infer SD>
  ? AnnotationUpdateType<SD>
  : Schema extends StateDefinition
  ? AnnotationUpdateType<Schema>
  : Schema extends InteropZodObject
  ? ZodUpdateType<Schema>
  : Fallback;

/**
 * Strongly-typed utility for authoring graph nodes outside of the StateGraph builder,
 * supporting inference for both state (from Schema) and runtime context (from ContextType).
 *
 * This type enables you to define graph node functions with full type safety—both
 * for the evolving state and for additional context that may be passed in at runtime.
 * Typing the context parameter allows for better code organization and precise editor support.
 *
 * Works with StateSchema, AnnotationRoot, and Zod object schemas for state, and
 * with a user-defined object shape for context.
 *
 * @template Schema - The state schema type (StateSchema, AnnotationRoot, or InteropZodObject)
 * @template ContextType - The type of the runtime context injected into this node (default: Record<string, unknown>)
 * @template Nodes - An optional union of valid node names for Command.goto, used for type-safe routing (default: string)
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
 * // Context shape for custom node logic (optional)
 * type MyContext = { userId: string };
 *
 * // Node receiving state and context
 * const processNode: GraphNode<typeof AgentState, MyContext> = (state, runtime) => {
 *   const { userId } = runtime; // type-safe context access
 *   return { step: state.step + 1 };
 * };
 *
 * // Node with type-safe graph routing
 * const routerNode: GraphNode<typeof AgentState, MyContext, "agent" | "tool"> = (state, runtime) => {
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
  ContextType extends Record<string, unknown> = Record<string, unknown>,
  Nodes extends string = string
> = (
  state: ExtractStateType<Schema>,
  runtime: Runtime<ContextType>
) =>
  | ExtractUpdateType<Schema>
  | CommandInstance<unknown, ExtractUpdateType<Schema>, Nodes>
  | Promise<
      | ExtractUpdateType<Schema>
      | CommandInstance<unknown, ExtractUpdateType<Schema>, Nodes>
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
