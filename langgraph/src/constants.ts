export const CONFIG_KEY_SEND = "__pregel_send";
export const CONFIG_KEY_READ = "__pregel_read";

export const INTERRUPT = "__interrupt__";

export const TAG_HIDDEN = "langsmith:hidden";

export const TASKS = "__pregel_tasks";

export interface SendInterface {
  node: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any;
}

export function _isSendInterface(x: unknown): x is SendInterface {
  const operation = x as SendInterface;
  return typeof operation.node === "string" && operation.args !== undefined;
}

/**
 * A message or packet to send to a specific node in the graph.
 *
 * The `Send` class is used within a `StateGraph`'s conditional edges to
 * dynamically invoke a node with a custom state at the next step.
 *
 * Importantly, the sent state can differ from the core graph's state,
 * allowing for flexible and dynamic workflow management.
 *
 * One such example is a "map-reduce" workflow where your graph invokes
 * the same node multiple times in parallel with different states,
 * before aggregating the results back into the main graph's state.
 *
 * @example
 * ```typescript
 * import { Annotation, Send, StateGraph } from "@langchain/langgraph";
 *
 * const ChainState = Annotation.Root({
 *   subjects: Annotation<string[]>,
 *   jokes: Annotation<string[]>({
 *     reducer: (a, b) => a.concat(b),
 *   }),
 * });
 *
 * const continueToJokes = async (state: typeof ChainState.State) => {
 *   return state.subjects.map((subject) => {
 *     return new Send("generate_joke", { subjects: [subject] });
 *   });
 * };
 *
 * const graph = new StateGraph(ChainState)
 *   .addNode("generate_joke", (state) => ({
 *     jokes: [`Joke about ${state.subjects}`],
 *   }))
 *   .addConditionalEdges("__start__", continueToJokes)
 *   .addEdge("generate_joke", "__end__")
 *   .compile();
 *
 * const res = await graph.invoke({ subjects: ["cats", "dogs"] });
 * console.log(res);
 *
 * // Invoking with two subjects results in a generated joke for each
 * // { subjects: ["cats", "dogs"], jokes: [`Joke about cats`, `Joke about dogs`] }
 * ```
 */
export class Send implements SendInterface {
  lg_name = "Send";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(public node: string, public args: any) {}
}

export function _isSend(x: unknown): x is Send {
  const operation = x as Send;
  return operation.lg_name === "Send";
}
