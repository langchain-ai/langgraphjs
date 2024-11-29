export const MISSING = Symbol.for("__missing__");

export const INPUT = "__input__";
export const ERROR = "__error__";
export const CONFIG_KEY_SEND = "__pregel_send";
export const CONFIG_KEY_READ = "__pregel_read";
export const CONFIG_KEY_CHECKPOINTER = "__pregel_checkpointer";
export const CONFIG_KEY_RESUMING = "__pregel_resuming";
export const CONFIG_KEY_TASK_ID = "__pregel_task_id";
export const CONFIG_KEY_STREAM = "__pregel_stream";
export const CONFIG_KEY_RESUME_VALUE = "__pregel_resume_value";

// this one is part of public API
export const CONFIG_KEY_CHECKPOINT_MAP = "checkpoint_map";

export const INTERRUPT = "__interrupt__";
export const RESUME = "__resume__";
export const RUNTIME_PLACEHOLDER = "__pregel_runtime_placeholder__";
export const RECURSION_LIMIT_DEFAULT = 25;

export const TAG_HIDDEN = "langsmith:hidden";
export const TAG_NOSTREAM = "langsmith:nostream";

export const TASKS = "__pregel_tasks";
export const PUSH = "__pregel_push";
export const PULL = "__pregel_pull";

export const TASK_NAMESPACE = "6ba7b831-9dad-11d1-80b4-00c04fd430c8";
export const NULL_TASK_ID = "00000000-0000-0000-0000-000000000000";

export const RESERVED = [
  INTERRUPT,
  RESUME,
  ERROR,
  TASKS,
  CONFIG_KEY_SEND,
  CONFIG_KEY_READ,
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_RESUMING,
  CONFIG_KEY_TASK_ID,
  CONFIG_KEY_STREAM,
  CONFIG_KEY_CHECKPOINT_MAP,
  INPUT,
];

export const CHECKPOINT_NAMESPACE_SEPARATOR = "|";
export const CHECKPOINT_NAMESPACE_END = ":";

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
 *
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

export type Interrupt = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  when: "during";
};

export class Command<R = unknown> {
  lg_name = "Command";

  resume: R;

  constructor(args: { resume: R }) {
    this.resume = args.resume;
  }
}

export function _isCommand(x: unknown): x is Command {
  return typeof x === "object" && !!x && (x as Command).lg_name === "Command";
}
