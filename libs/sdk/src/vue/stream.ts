/* __LC_ALLOW_ENTRYPOINT_SIDE_EFFECTS__ */
import { useStreamLGP } from "./stream.lgp.js";
import { useStreamCustom } from "./stream.custom.js";
import type { UseStreamOptions, InferAgentState } from "../ui/types.js";
import type { BagTemplate } from "../types.template.js";
import type {
  UseStream,
  UseStreamCustom,
  UseStreamCustomOptions,
} from "./types.js";

function isCustomOptions<
  StateType extends Record<string, unknown> = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options:
    | UseStreamOptions<StateType, Bag>
    | UseStreamCustomOptions<StateType, Bag>
): options is UseStreamCustomOptions<StateType, Bag> {
  return "transport" in options;
}

/**
 * Helper type that infers StateType based on whether T is an agent-like type, a CompiledGraph/Pregel instance, or a state type.
 * - If T has `~agentTypes`, returns the full agent state including:
 *   - Base agent state with typed messages based on the agent's tools
 *   - The agent's custom state schema
 *   - All middleware states
 * - If T has `~RunOutput` (CompiledGraph/CompiledStateGraph), returns the state type
 * - If T has `~OutputType` (Pregel), returns the output type as state
 * - Otherwise, returns T (direct state type)
 */
type InferStateType<T> = T extends { "~agentTypes": unknown }
  ? InferAgentState<T>
  : T extends { "~RunOutput": infer S }
  ? S extends Record<string, unknown>
    ? S
    : Record<string, unknown>
  : T extends { "~OutputType": infer O }
  ? O extends Record<string, unknown>
    ? O
    : Record<string, unknown>
  : T extends Record<string, unknown>
  ? T
  : Record<string, unknown>;

/**
 * Helper type that infers Bag based on whether T is an agent-like type.
 * - If T has `~agentTypes`, extracts bag from the agent's tools
 * - Otherwise, returns the default BagTemplate
 */
type InferBag<T, B extends BagTemplate = BagTemplate> = T extends {
  "~agentTypes": unknown;
}
  ? BagTemplate
  : B;

/**
 * A Vue 3 composable that integrates with LangGraph streaming.
 *
 * - If you pass `transport`, `useStream` uses the custom transport implementation.
 * - Otherwise it uses the LangGraph Platform SDK client (LGP) implementation.
 *
 * @example
 * ```ts
 * import { useStream } from "@langchain/langgraph-sdk/vue";
 *
 * const stream = useStream({
 *   assistantId: "my-graph",
 *   apiUrl: "http://localhost:2024",
 * });
 *
 * // Vue refs:
 * // stream.values.value
 * // stream.messages.value
 * // stream.isLoading.value
 * ```
 */
export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: UseStreamOptions<InferStateType<T>, InferBag<T, Bag>>
): UseStream<InferStateType<T>, InferBag<T, Bag>>;

export function useStream<
  T = Record<string, unknown>,
  Bag extends BagTemplate = BagTemplate
>(
  options: UseStreamCustomOptions<InferStateType<T>, InferBag<T, Bag>>
): UseStreamCustom<InferStateType<T>, InferBag<T, Bag>>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStream(options: any): any {
  if (isCustomOptions(options)) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useStreamCustom(options);
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useStreamLGP(options);
}
