/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  isInteropZodObject,
  type InteropZodObject,
} from "@langchain/core/utils/types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
  LangGraphRunnableConfig,
  Runtime,
} from "../pregel/runnable_types.js";
import type { CommandInstance, Send } from "../constants.js";
import { END } from "../constants.js";
import type {
  AnnotationRoot,
  StateDefinition,
  StateType,
  UpdateType as AnnotationUpdateType,
} from "./annotation.js";
import {
  AnyStateSchema,
  StateSchema,
  StateSchemaFieldsToStateDefinition,
} from "../state/schema.js";
import type { InteropZodToStateDefinition } from "./zod/meta.js";
import { isBaseChannel } from "../channels/base.js";

// Re-export END for use in ConditionalEdgeRouter return types
export { END };

/**
 * Convert any supported schema type to a StateDefinition.
 *
 * @internal
 */
export type ToStateDefinition<T> = T extends StateSchema<infer TInit>
  ? StateSchemaFieldsToStateDefinition<TInit>
  : T extends AnnotationRoot<infer SD>
  ? SD
  : T extends InteropZodObject
  ? InteropZodToStateDefinition<T>
  : T extends StateDefinition
  ? T
  : never;

/**
 * Type for schema types that can be used to initialize state.
 * Supports all valid schema types: StateDefinition, Zod objects, StateSchema, and AnnotationRoot.
 *
 * @internal
 */
export type StateDefinitionInit =
  | StateDefinition
  | InteropZodObject
  | AnyStateSchema
  | AnnotationRoot<any>;

/**
 * Check if a value is a valid StateDefinitionInit type.
 * Supports: StateSchema, InteropZodObject (Zod), AnnotationRoot, StateDefinition
 *
 * @internal
 */
export function isStateDefinitionInit(
  value: unknown
): value is StateDefinitionInit {
  if (value == null) return false;

  // StateSchema
  if (StateSchema.isInstance(value)) return true;

  // InteropZodObject (Zod v3/v4 object schemas)
  if (isInteropZodObject(value)) return true;

  // AnnotationRoot
  if (
    typeof value === "object" &&
    "lc_graph_name" in value &&
    (value as { lc_graph_name: unknown }).lc_graph_name === "AnnotationRoot"
  ) {
    return true;
  }

  // StateDefinition (raw channel map)
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0 &&
    Object.values(value).every(
      (v) => typeof v === "function" || isBaseChannel(v)
    )
  ) {
    return true;
  }

  return false;
}

/**
 * Valid types for context schema.
 * Context doesn't have channels/reducers, so StateSchema is NOT supported.
 * Supports StandardSchemaV1 (Zod, Valibot, etc.) and AnnotationRoot (backward compat).
 *
 * @internal
 */
export type ContextSchemaInit =
  | StandardSchemaV1
  | AnnotationRoot<StateDefinition>;

/**
 * Initialization options for StateGraph.
 * Accepts any combination of schema types for state/input/output.
 *
 * Supports both `state` and `stateSchema` as aliases for backward compatibility.
 * If only `input` is provided (no state/stateSchema), `input` is used as the state schema.
 *
 * @template SD - State definition type
 * @template I - Input definition type (defaults to undefined)
 * @template O - Output definition type (defaults to undefined)
 * @template C - Context schema type (defaults to undefined)
 * @template N - Node name union type (defaults to string)
 * @template InterruptType - Interrupt type (defaults to unknown)
 * @template WriterType - Writer type (defaults to unknown)
 */
export type StateGraphInit<
  SD extends StateDefinitionInit = StateDefinitionInit,
  I extends StateDefinitionInit | undefined = undefined,
  O extends StateDefinitionInit | undefined = undefined,
  C extends StateDefinitionInit | undefined = undefined,
  N extends string = string,
  InterruptType = unknown,
  WriterType = unknown
> = {
  /** Primary key for state schema */
  state?: SD;

  /**
   * @deprecated Use `state` instead. Will be removed in a future version.
   */
  stateSchema?: SD;

  input?: I;
  output?: O;

  /** Context schema for runtime configuration validation. Does not support StateSchema. */
  context?: C;

  interrupt?: InterruptType;
  writer?: WriterType;
  nodes?: N[];
};

/**
 * Options for the second argument when passing a direct schema.
 * Excludes `state` and `stateSchema` since those come from the first arg.
 *
 * @internal
 */
export type StateGraphOptions<
  I extends StateDefinitionInit | undefined = undefined,
  O extends StateDefinitionInit | undefined = undefined,
  C extends StateDefinitionInit | undefined = undefined,
  N extends string = string,
  InterruptType = unknown,
  WriterType = unknown
> = Omit<
  StateGraphInit<StateDefinitionInit, I, O, C, N, InterruptType, WriterType>,
  "state" | "stateSchema"
>;

/**
 * Check if a value is a StateGraphInit object (has state, stateSchema, or input with valid schema).
 *
 * @internal
 */
export function isStateGraphInit(
  value: unknown
): value is StateGraphInit<StateDefinitionInit> {
  if (typeof value !== "object" || value == null) return false;

  const obj = value as Record<string, unknown>;

  // Must have at least one of: state, stateSchema, or input
  const hasState = "state" in obj && isStateDefinitionInit(obj.state);
  const hasStateSchema =
    "stateSchema" in obj && isStateDefinitionInit(obj.stateSchema);
  const hasInput = "input" in obj && isStateDefinitionInit(obj.input);

  if (!hasState && !hasStateSchema && !hasInput) return false;

  // Validate input/output if provided
  if ("input" in obj && obj.input != null && !isStateDefinitionInit(obj.input))
    return false;
  if (
    "output" in obj &&
    obj.output != null &&
    !isStateDefinitionInit(obj.output)
  )
    return false;

  return true;
}

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
 * @template FallbackBase - Base type for fallback (will be partialized), defaults to Schema
 */
export type ExtractUpdateType<
  Schema,
  FallbackBase = Schema
> = Schema extends AnnotationRoot<infer SD>
  ? AnnotationUpdateType<SD>
  : AnnotationUpdateType<ToStateDefinition<Schema>> extends infer U
  ? [U] extends [never]
    ? Partial<FallbackBase>
    : U
  : Partial<FallbackBase>;

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
 * Return type for conditional edge routing functions.
 */
type ConditionalEdgeRouterReturnValue<Nodes extends string, State> =
  | Nodes
  | typeof END
  | Send<Nodes, State>
  | Array<Nodes | Send<Nodes, State>>;

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
 *   (state, config) => {
 *     const userId = config.context?.userId;
 *     if (state.done) return END;
 *     return state.needsTool ? "tool" : "agent";
 *   };
 *
 * graph.addConditionalEdges("router", router, ["agent", "tool"]);
 * ```
 */
export type ConditionalEdgeRouter<
  Schema,
  Context extends Record<string, unknown> = Record<string, unknown>,
  Nodes extends string = string
> = (
  state: ExtractStateType<Schema>,
  config: LangGraphRunnableConfig<Context>
) =>
  | ConditionalEdgeRouterReturnValue<Nodes, ExtractStateType<Schema>>
  | Promise<ConditionalEdgeRouterReturnValue<Nodes, ExtractStateType<Schema>>>;
