import { PendingWrite } from "@langchain/langgraph-checkpoint";

/** Special reserved node name denoting the start of a graph. */
export const START = "__start__";
/** Special reserved node name denoting the end of a graph. */
export const END = "__end__";
export const INPUT = "__input__";
export const COPY = "__copy__";
export const ERROR = "__error__";

/** Special reserved cache namespaces */
export const CACHE_NS_WRITES = "__pregel_ns_writes";

export const CONFIG_KEY_SEND = "__pregel_send";
/** config key containing function used to call a node (push task) */
export const CONFIG_KEY_CALL = "__pregel_call";
export const CONFIG_KEY_READ = "__pregel_read";
export const CONFIG_KEY_CHECKPOINTER = "__pregel_checkpointer";
export const CONFIG_KEY_RESUMING = "__pregel_resuming";
export const CONFIG_KEY_TASK_ID = "__pregel_task_id";
export const CONFIG_KEY_STREAM = "__pregel_stream";
export const CONFIG_KEY_RESUME_VALUE = "__pregel_resume_value";
export const CONFIG_KEY_RESUME_MAP = "__pregel_resume_map";
export const CONFIG_KEY_SCRATCHPAD = "__pregel_scratchpad";
/** config key containing state from previous invocation of graph for the given thread */
export const CONFIG_KEY_PREVIOUS_STATE = "__pregel_previous";
export const CONFIG_KEY_CHECKPOINT_ID = "checkpoint_id";
export const CONFIG_KEY_CHECKPOINT_NS = "checkpoint_ns";

export const CONFIG_KEY_NODE_FINISHED = "__pregel_node_finished";

// this one is part of public API
export const CONFIG_KEY_CHECKPOINT_MAP = "checkpoint_map";

export const CONFIG_KEY_ABORT_SIGNALS = "__pregel_abort_signals";

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface SendInterface<Node extends string = string, Args = any> {
  node: Node;
  args: Args;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export class Send<Node extends string = string, Args = any>
  implements SendInterface<Node, Args>
{
  lg_name = "Send";

  public node: Node;

  public args: Args;

  constructor(node: Node, args: Args) {
    this.node = node;
    this.args = _deserializeCommandSendObjectGraph(args) as Args;
  }

  toJSON() {
    return { lg_name: this.lg_name, node: this.node, args: this.args };
  }
}

export function _isSend(x: unknown): x is Send {
  // eslint-disable-next-line no-instanceof/no-instanceof
  return x instanceof Send;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Interrupt<Value = any> = {
  value?: Value;
  // eslint-disable-next-line @typescript-eslint/ban-types
  when: "during" | (string & {});
  resumable?: boolean;
  ns?: string[];
};

/**
 * Checks if the given graph invoke / stream chunk contains interrupt.
 *
 * @example
 * ```ts
 * import { INTERRUPT, isInterrupted } from "@langchain/langgraph";
 *
 * const values = await graph.invoke({ foo: "bar" });
 * if (isInterrupted<string>(values)) {
 *   const interrupt = values[INTERRUPT][0].value;
 * }
 * ```
 *
 * @param values - The values to check.
 * @returns `true` if the values contain an interrupt, `false` otherwise.
 */
export function isInterrupted<Value = unknown>(
  values: unknown
): values is { [INTERRUPT]: Interrupt<Value>[] } {
  if (!values || typeof values !== "object") return false;
  if (!(INTERRUPT in values)) return false;
  return Array.isArray(values[INTERRUPT]);
}

export type CommandParams<
  Resume = unknown,
  Update extends Record<string, unknown> = Record<string, unknown>,
  Nodes extends string = string
> = {
  /**
   * A discriminator field used to identify the type of object. Must be populated when serializing.
   *
   * Optional because it's not required to specify this when directly constructing a {@link Command}
   * object.
   */
  lg_name?: "Command";

  /**
   * Value to resume execution with. To be used together with {@link interrupt}.
   */
  resume?: Resume;
  /**
   * Graph to send the command to. Supported values are:
   *   - None: the current graph (default)
   *   - The specific name of the graph to send the command to
   *   - {@link Command.PARENT}: closest parent graph (only supported when returned from a node in a subgraph)
   */
  graph?: string;

  /**
   * Update to apply to the graph's state.
   */
  update?: Update | [string, unknown][];

  /**
   * Can be one of the following:
   *   - name of the node to navigate to next (any node that belongs to the specified `graph`)
   *   - sequence of node names to navigate to next
   *   - `Send` object (to execute a node with the input provided)
   *   - sequence of `Send` objects
   */
  goto?:
    | Nodes
    | SendInterface<Nodes> // eslint-disable-line @typescript-eslint/no-explicit-any
    | (Nodes | SendInterface<Nodes>)[]; // eslint-disable-line @typescript-eslint/no-explicit-any
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
export class Command<
  Resume = unknown,
  Update extends Record<string, unknown> = Record<string, unknown>,
  Nodes extends string = string
> {
  readonly lg_name = "Command";

  lc_direct_tool_output = true;

  /**
   * Graph to send the command to. Supported values are:
   *   - None: the current graph (default)
   *   - The specific name of the graph to send the command to
   *   - {@link Command.PARENT}: closest parent graph (only supported when returned from a node in a subgraph)
   */
  graph?: string;

  /**
   * Update to apply to the graph's state as a result of executing the node that is returning the command.
   * Written to the state as if the node had simply returned this value instead of the Command object.
   */
  update?: Update | [string, unknown][];

  /**
   * Value to resume execution with. To be used together with {@link interrupt}.
   */
  resume?: Resume;

  /**
   * Can be one of the following:
   *   - name of the node to navigate to next (any node that belongs to the specified `graph`)
   *   - sequence of node names to navigate to next
   *   - {@link Send} object (to execute a node with the exact input provided in the {@link Send} object)
   *   - sequence of {@link Send} objects
   */
  goto?: Nodes | Send<Nodes> | (Nodes | Send<Nodes>)[] = [];

  static PARENT = "__parent__";

  constructor(args: CommandParams<Resume, Update, Nodes>) {
    this.resume = args.resume;
    this.graph = args.graph;
    this.update = args.update;
    if (args.goto) {
      type ValidArg = Nodes | Send<Nodes, Update>;

      this.goto = Array.isArray(args.goto)
        ? (_deserializeCommandSendObjectGraph(args.goto) as ValidArg[])
        : [_deserializeCommandSendObjectGraph(args.goto) as ValidArg];
    }
  }

  /**
   * Convert the update field to a list of {@link PendingWrite} tuples
   * @returns List of {@link PendingWrite} tuples of the form `[channelKey, value]`.
   * @internal
   */
  _updateAsTuples(): PendingWrite[] {
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
      serializedGoto = this.goto?.map((innerGoto) => {
        if (typeof innerGoto === "string") {
          return innerGoto;
        } else {
          return innerGoto.toJSON();
        }
      });
    }
    return {
      lg_name: this.lg_name,
      update: this.update,
      resume: this.resume,
      goto: serializedGoto,
    };
  }
}

/**
 * A type guard to check if the given value is a {@link Command}.
 *
 * Useful for type narrowing when working with the {@link Command} object.
 *
 * @param x - The value to check.
 * @returns `true` if the value is a {@link Command}, `false` otherwise.
 */
export function isCommand(x: unknown): x is Command {
  if (typeof x !== "object") {
    return false;
  }

  if (x === null || x === undefined) {
    return false;
  }

  if ("lg_name" in x && x.lg_name === "Command") {
    return true;
  }

  return false;
}

/**
 * Reconstructs Command and Send objects from a deeply nested tree of anonymous objects
 * matching their interfaces.
 *
 * This is only exported for testing purposes. It is NOT intended to be used outside of
 * the Command and Send classes.
 *
 * @internal
 *
 * @param x - The command send tree to convert.
 * @param seen - A map of seen objects to avoid infinite loops.
 * @returns The converted command send tree.
 */
export function _deserializeCommandSendObjectGraph(
  x: unknown,
  seen: Map<object, unknown> = new Map()
): unknown {
  if (x !== undefined && x !== null && typeof x === "object") {
    // If we've already processed this object, return the transformed version
    if (seen.has(x)) {
      return seen.get(x);
    }

    let result: unknown;

    if (Array.isArray(x)) {
      // Create the array first, then populate it
      result = [];
      // Add to seen map before processing elements to handle self-references
      seen.set(x, result);

      // Now populate the array
      x.forEach((item, index) => {
        (result as unknown[])[index] = _deserializeCommandSendObjectGraph(
          item,
          seen
        );
      });
      // eslint-disable-next-line no-instanceof/no-instanceof
    } else if (isCommand(x) && !(x instanceof Command)) {
      result = new Command(x);
      seen.set(x, result);
      // eslint-disable-next-line no-instanceof/no-instanceof
    } else if (_isSendInterface(x) && !(x instanceof Send)) {
      result = new Send(x.node, x.args);
      seen.set(x, result);
    } else if (isCommand(x) || _isSend(x)) {
      result = x;
      seen.set(x, result);
    } else if ("lc_serializable" in x && x.lc_serializable) {
      result = x;
      seen.set(x, result);
    } else {
      // Create empty object first
      result = {};
      // Add to seen map before processing properties to handle self-references
      seen.set(x, result);

      // Now populate the object
      for (const [key, value] of Object.entries(x)) {
        (result as Record<string, unknown>)[key] =
          _deserializeCommandSendObjectGraph(value, seen);
      }
    }

    return result;
  }
  return x;
}
