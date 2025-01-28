/** Special reserved node name denoting the start of a graph. */
export const START = "__start__";
/** Special reserved node name denoting the end of a graph. */
export const END = "__end__";
export const INPUT = "__input__";
export const ERROR = "__error__";
export const CONFIG_KEY_SEND = "__pregel_send";
/** config key containing function used to call a node (push task) */
export const CONFIG_KEY_CALL = "__pregel_call";
export const CONFIG_KEY_READ = "__pregel_read";
export const CONFIG_KEY_CHECKPOINTER = "__pregel_checkpointer";
export const CONFIG_KEY_RESUMING = "__pregel_resuming";
export const CONFIG_KEY_TASK_ID = "__pregel_task_id";
export const CONFIG_KEY_STREAM = "__pregel_stream";
export const CONFIG_KEY_RESUME_VALUE = "__pregel_resume_value";
export const CONFIG_KEY_SCRATCHPAD = "__pregel_scratchpad";
/** config key containing state from previous invocation of graph for the given thread */
export const CONFIG_KEY_PREVIOUS_STATE = "__pregel_previous";
export const CONFIG_KEY_CHECKPOINT_ID = "checkpoint_id";
export const CONFIG_KEY_CHECKPOINT_NS = "checkpoint_ns";

// this one is part of public API
export const CONFIG_KEY_CHECKPOINT_MAP = "checkpoint_map";

/** Special channel reserved for graph interrupts */
export const INTERRUPT = "__interrupt__";
/** Special channel reserved for graph resume */
export const RESUME = "__resume__";
/** Special channel reserved for cases when a task exits without any writes */
export const NO_WRITES = "__no_writes__";
/** Special channel reserved for graph return */
export const RETURN = "__return__";
/** Special channel reserved for graph previous state */
export const PREVIOUS = "__previous__";
export const RUNTIME_PLACEHOLDER = "__pregel_runtime_placeholder__";
export const RECURSION_LIMIT_DEFAULT = 25;

export const TAG_HIDDEN = "langsmith:hidden";
export const TAG_NOSTREAM = "langsmith:nostream";
export const SELF = "__self__";

export const TASKS = "__pregel_tasks";
export const PUSH = "__pregel_push";
export const PULL = "__pregel_pull";

export const TASK_NAMESPACE = "6ba7b831-9dad-11d1-80b4-00c04fd430c8";
export const NULL_TASK_ID = "00000000-0000-0000-0000-000000000000";

export const RESERVED = [
  TAG_HIDDEN,
  INPUT,
  INTERRUPT,
  RESUME,
  ERROR,
  NO_WRITES,
  TASKS,

  // reserved config.configurable keys
  CONFIG_KEY_SEND,
  CONFIG_KEY_READ,
  CONFIG_KEY_CHECKPOINTER,
  CONFIG_KEY_STREAM,
  CONFIG_KEY_RESUMING,
  CONFIG_KEY_TASK_ID,
  CONFIG_KEY_CALL,
  CONFIG_KEY_RESUME_VALUE,
  CONFIG_KEY_SCRATCHPAD,
  CONFIG_KEY_PREVIOUS_STATE,
  CONFIG_KEY_CHECKPOINT_MAP,
  CONFIG_KEY_CHECKPOINT_NS,
  CONFIG_KEY_CHECKPOINT_ID,
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
  return (
    operation !== null &&
    operation !== undefined &&
    typeof operation.node === "string" &&
    operation.args !== undefined
  );
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

  toJSON() {
    return {
      node: this.node,
      args: this.args,
    };
  }
}

export function _isSend(x: unknown): x is Send {
  const operation = x as Send;
  return operation !== undefined && operation.lg_name === "Send";
}

export type Interrupt = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  value: any;
  when: "during";
  resumable?: boolean;
  ns?: string[];
};

export type CommandParams<R> = {
  /**
   * Value to resume execution with. To be used together with {@link interrupt}.
   */
  resume?: R;
  /**
   * Graph to send the command to. Supported values are:
   *   - None: the current graph (default)
   *   - GraphCommand.PARENT: closest parent graph
   */
  graph?: string;

  /**
   * Update to apply to the graph's state.
   */
  update?: Record<string, unknown> | [string, unknown][];

  /**
   * Can be one of the following:
   *   - name of the node to navigate to next (any node that belongs to the specified `graph`)
   *   - sequence of node names to navigate to next
   *   - `Send` object (to execute a node with the input provided)
   *   - sequence of `Send` objects
   */
  goto?: string | Send | (string | Send)[];
};

/**
 * One or more commands to update the graph's state and send messages to nodes.
 * Can be used to combine routing logic with state updates in lieu of conditional edges
 *
 * @example
 * ```ts
 * import { Annotation, Command } from "@langchain/langgraph";
 *
 * // Define graph state
 * const StateAnnotation = Annotation.Root({
 *   foo: Annotation<string>,
 * });
 *
 * // Define the nodes
 * const nodeA = async (_state: typeof StateAnnotation.State) => {
 *   console.log("Called A");
 *   // this is a replacement for a real conditional edge function
 *   const goto = Math.random() > .5 ? "nodeB" : "nodeC";
 *   // note how Command allows you to BOTH update the graph state AND route to the next node
 *   return new Command({
 *     // this is the state update
 *     update: {
 *       foo: "a",
 *     },
 *     // this is a replacement for an edge
 *     goto,
 *   });
 * };
 *
 * // Nodes B and C are unchanged
 * const nodeB = async (state: typeof StateAnnotation.State) => {
 *   console.log("Called B");
 *   return {
 *     foo: state.foo + "|b",
 *   };
 * }
 *
 * const nodeC = async (state: typeof StateAnnotation.State) => {
 *   console.log("Called C");
 *   return {
 *     foo: state.foo + "|c",
 *   };
 * }
 * 
 * import { StateGraph } from "@langchain/langgraph";

 * // NOTE: there are no edges between nodes A, B and C!
 * const graph = new StateGraph(StateAnnotation)
 *   .addNode("nodeA", nodeA, {
 *     ends: ["nodeB", "nodeC"],
 *   })
 *   .addNode("nodeB", nodeB)
 *   .addNode("nodeC", nodeC)
 *   .addEdge("__start__", "nodeA")
 *   .compile();
 * 
 * await graph.invoke({ foo: "" });
 *
 * // Randomly oscillates between
 * // { foo: 'a|c' } and { foo: 'a|b' }
 * ```
 */
export class Command<R = unknown> {
  lg_name = "Command";

  lc_direct_tool_output = true;

  graph?: string;

  update?: Record<string, unknown> | [string, unknown][];

  resume?: R;

  goto: string | Send | (string | Send)[] = [];

  static PARENT = "__parent__";

  constructor(args: CommandParams<R>) {
    this.resume = args.resume;
    this.graph = args.graph;
    this.update = args.update;
    if (args.goto) {
      this.goto = Array.isArray(args.goto) ? args.goto : [args.goto];
    }
  }

  _updateAsTuples(): [string, unknown][] {
    if (
      this.update &&
      typeof this.update === "object" &&
      !Array.isArray(this.update)
    ) {
      return Object.entries(this.update);
    } else if (
      Array.isArray(this.update) &&
      this.update.every(
        (t): t is [string, unknown] =>
          Array.isArray(t) && t.length === 2 && typeof t[0] === "string"
      )
    ) {
      return this.update;
    } else {
      return [["__root__", this.update]];
    }
  }

  toJSON() {
    let serializedGoto;
    if (typeof this.goto === "string") {
      serializedGoto = this.goto;
    } else if (_isSend(this.goto)) {
      serializedGoto = this.goto.toJSON();
    } else {
      serializedGoto = this.goto.map((innerGoto) => {
        if (typeof innerGoto === "string") {
          return innerGoto;
        } else {
          return innerGoto.toJSON();
        }
      });
    }
    return {
      update: this.update,
      resume: this.resume,
      goto: serializedGoto,
    };
  }
}

export function isCommand(x: unknown): x is Command {
  return typeof x === "object" && !!x && (x as Command).lg_name === "Command";
}
