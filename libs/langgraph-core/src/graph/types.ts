import type { Runtime } from "../pregel/runnable_types.js";
import type { CommandInstance, Send } from "../constants.js";
import { END } from "../constants.js";
import type { StateType } from "../index.js";
import type {
  AnnotationRoot,
  UpdateType as AnnotationUpdateType,
} from "./annotation.js";
import type { ToStateDefinition } from "./state.js";

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
> = Schema extends AnnotationRoot<infer SD>
  ? StateType<SD>
  : StateType<ToStateDefinition<Schema>> extends infer S
  ? [S] extends [never]
    ? Fallback
    : S
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
 * @template Fallback - Base type for fallback, defaults to Partial<Schema>
 */
export type ExtractUpdateType<
  Schema,
  Fallback = Partial<Schema>
> = Schema extends AnnotationRoot<infer SD>
  ? AnnotationUpdateType<SD>
  : AnnotationUpdateType<ToStateDefinition<Schema>> extends infer U
  ? [U] extends [never]
    ? Fallback
    : U
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
 * @template Context - The type of the runtime context injected into this node (default: Record<string, unknown>)
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
  Context = Record<string, unknown>,
  Nodes extends string = string
> = (
  state: ExtractStateType<Schema>,
  runtime: Runtime<Context>
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
 * full type safety on state, runtime context, and return values.
 *
 * @template Schema - The state schema type
 * @template Context - The runtime context type available to node logic
 * @template Nodes - Union of valid node names that can be routed to
 *
 * @example
 * ```typescript
 * type MyContext = { userId: string };
 * const router: ConditionalEdgeRouter<typeof AgentState, MyContext, "agent" | "tool"> =
 *   (state, runtime) => {
 *     // Access runtime context as type-safe: runtime.userId
 *     if (state.done) return END;
 *     return state.needsTool ? "tool" : "agent";
 *   };
 *
 * graph.addConditionalEdges("router", router, ["agent", "tool"]);
 * ```
 */
export type ConditionalEdgeRouter<
  Schema,
  Context = Record<string, unknown>,
  Nodes extends string = string
> = (
  state: ExtractStateType<Schema>,
  runtime: Runtime<Context>
) =>
  | Nodes
  | typeof END
  | Send<Nodes, ExtractStateType<Schema>>
  | Array<Nodes | Send<Nodes, ExtractStateType<Schema>>>;
