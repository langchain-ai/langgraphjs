/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  _coerceToRunnable,
  Runnable,
  RunnableLike,
} from "@langchain/core/runnables";
import { All, BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import { BaseChannel } from "../channels/base.js";
import {
  END,
  CompiledGraph,
  Graph,
  START,
  Branch,
  AddNodeOptions,
  NodeSpec,
} from "./graph.js";
import {
  ChannelWrite,
  ChannelWriteEntry,
  PASSTHROUGH,
  SKIP_WRITE,
} from "../pregel/write.js";
import { ChannelRead, PregelNode } from "../pregel/read.js";
import { NamedBarrierValue } from "../channels/named_barrier_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { RunnableCallable } from "../utils.js";
import {
  _isSend,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Send,
  TAG_HIDDEN,
} from "../constants.js";
import { InvalidUpdateError } from "../errors.js";
import {
  AnnotationRoot,
  getChannel,
  SingleReducer,
  StateDefinition,
  StateType,
  UpdateType,
} from "./annotation.js";
import type { RetryPolicy } from "../pregel/utils.js";
import { BaseStore } from "../store/base.js";

const ROOT = "__root__";

export type ChannelReducers<Channels extends object> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof Channels]: SingleReducer<Channels[K], any>;
};

export interface StateGraphArgs<Channels extends object | unknown> {
  channels: Channels extends object
    ? Channels extends unknown[]
      ? ChannelReducers<{ __root__: Channels }>
      : ChannelReducers<Channels>
    : ChannelReducers<{ __root__: Channels }>;
}

export type StateGraphNodeSpec<RunInput, RunOutput> = NodeSpec<
  RunInput,
  RunOutput
> & {
  input?: StateDefinition;
  retryPolicy?: RetryPolicy;
};

export type StateGraphAddNodeOptions = {
  retryPolicy?: RetryPolicy;
  // TODO: Fix generic typing
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: AnnotationRoot<any>;
} & AddNodeOptions;

export type StateGraphArgsWithStateSchema<
  SD extends StateDefinition,
  I extends StateDefinition,
  O extends StateDefinition
> = {
  stateSchema: AnnotationRoot<SD>;
  input?: AnnotationRoot<I>;
  output?: AnnotationRoot<O>;
};

export type StateGraphArgsWithInputOutputSchemas<
  SD extends StateDefinition,
  O extends StateDefinition = SD
> = {
  input: AnnotationRoot<SD>;
  output: AnnotationRoot<O>;
};

/**
 * A graph whose nodes communicate by reading and writing to a shared state.
 * Each node takes a defined `State` as input and returns a `Partial<State>`.
 *
 * Each state key can optionally be annotated with a reducer function that
 * will be used to aggregate the values of that key received from multiple nodes.
 * The signature of a reducer function is (left: Value, right: UpdateValue) => Value.
 *
 * See {@link Annotation} for more on defining state.
 *
 * After adding nodes and edges to your graph, you must call `.compile()` on it before
 * you can use it.
 *
 * @example
 * ```ts
 * import {
 *   type BaseMessage,
 *   AIMessage,
 *   HumanMessage,
 * } from "@langchain/core/messages";
 * import { StateGraph, Annotation } from "@langchain/langgraph";
 *
 * // Define a state with a single key named "messages" that will
 * // combine a returned BaseMessage or arrays of BaseMessages
 * const StateAnnotation = Annotation.Root({
 *   sentiment: Annotation<string>,
 *   messages: Annotation<BaseMessage[]>({
 *     reducer: (left: BaseMessage[], right: BaseMessage | BaseMessage[]) => {
 *       if (Array.isArray(right)) {
 *         return left.concat(right);
 *       }
 *       return left.concat([right]);
 *     },
 *     default: () => [],
 *   }),
 * });
 *
 * const graphBuilder = new StateGraph(StateAnnotation);
 *
 * // A node in the graph that returns an object with a "messages" key
 * // will update the state by combining the existing value with the returned one.
 * const myNode = (state: typeof StateAnnotation.State) => {
 *   return {
 *     messages: [new AIMessage("Some new response")],
 *     sentiment: "positive",
 *   };
 * };
 *
 * const graph = graphBuilder
 *   .addNode("myNode", myNode)
 *   .addEdge("__start__", "myNode")
 *   .addEdge("myNode", "__end__")
 *   .compile();
 *
 * await graph.invoke({ messages: [new HumanMessage("how are you?")] });
 *
 * // {
 * //   messages: [HumanMessage("how are you?"), AIMessage("Some new response")],
 * //   sentiment: "positive",
 * // }
 * ```
 */
export class StateGraph<
  SD extends StateDefinition | unknown,
  S = SD extends StateDefinition ? StateType<SD> : SD,
  U = SD extends StateDefinition ? UpdateType<SD> : Partial<S>,
  N extends string = typeof START,
  I extends StateDefinition = SD extends StateDefinition ? SD : StateDefinition,
  O extends StateDefinition = SD extends StateDefinition ? SD : StateDefinition
> extends Graph<N, S, U, StateGraphNodeSpec<S, U>> {
  channels: Record<string, BaseChannel> = {};

  // TODO: this doesn't dedupe edges as in py, so worth fixing at some point
  waitingEdges: Set<[N[], N]> = new Set();

  /** @internal */
  _schemaDefinition: StateDefinition;

  /** @internal */
  _inputDefinition: I;

  /** @internal */
  _outputDefinition: O;

  /**
   * Map schemas to managed values
   * @internal
   */
  _schemaDefinitions = new Map();

  constructor(
    fields: SD extends StateDefinition
      ?
          | SD
          | AnnotationRoot<SD>
          | StateGraphArgs<S>
          | StateGraphArgsWithStateSchema<SD, I, O>
          | StateGraphArgsWithInputOutputSchemas<SD, O>
      : StateGraphArgs<S>
  ) {
    super();
    if (
      isStateGraphArgsWithInputOutputSchemas<
        SD extends StateDefinition ? SD : never,
        O
      >(fields)
    ) {
      this._schemaDefinition = fields.input.spec;
      this._inputDefinition = fields.input.spec as unknown as I;
      this._outputDefinition = fields.output.spec;
    } else if (isStateGraphArgsWithStateSchema(fields)) {
      this._schemaDefinition = fields.stateSchema.spec;
      this._inputDefinition = (fields.input?.spec ??
        this._schemaDefinition) as I;
      this._outputDefinition = (fields.output?.spec ??
        this._schemaDefinition) as O;
    } else if (isStateDefinition(fields) || isAnnotationRoot(fields)) {
      const spec = isAnnotationRoot(fields) ? fields.spec : fields;
      this._schemaDefinition = spec;
    } else if (isStateGraphArgs(fields)) {
      const spec = _getChannels(fields.channels);
      this._schemaDefinition = spec;
    } else {
      throw new Error("Invalid StateGraph input.");
    }
    this._inputDefinition = this._inputDefinition ?? this._schemaDefinition;
    this._outputDefinition = this._outputDefinition ?? this._schemaDefinition;
    this._addSchema(this._schemaDefinition);
    this._addSchema(this._inputDefinition);
    this._addSchema(this._outputDefinition);
  }

  get allEdges(): Set<[string, string]> {
    return new Set([
      ...this.edges,
      ...Array.from(this.waitingEdges).flatMap(([starts, end]) =>
        starts.map((start) => [start, end] as [string, string])
      ),
    ]);
  }

  _addSchema(stateDefinition: StateDefinition) {
    if (this._schemaDefinitions.has(stateDefinition)) {
      return;
    }
    // TODO: Support managed values
    this._schemaDefinitions.set(stateDefinition, stateDefinition);
    for (const [key, val] of Object.entries(stateDefinition)) {
      let channel;
      if (typeof val === "function") {
        channel = val();
      } else {
        channel = val;
      }
      if (this.channels[key] !== undefined) {
        if (this.channels[key] !== channel) {
          if (channel.lc_graph_name !== "LastValue") {
            throw new Error(
              `Channel "${key}" already exists with a different type.`
            );
          }
        }
      } else {
        this.channels[key] = channel;
      }
    }
  }

  addNode<K extends string, NodeInput = S>(
    key: K,
    action: RunnableLike<
      NodeInput,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      U extends object ? U & Record<string, any> : U
    >,
    options?: StateGraphAddNodeOptions
  ): StateGraph<SD, S, U, N | K, I, O> {
    if (key in this.channels) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }

    if (key.includes(CHECKPOINT_NAMESPACE_SEPARATOR)) {
      throw new Error(
        `"${CHECKPOINT_NAMESPACE_SEPARATOR}" is a reserved character and is not allowed in node names.`
      );
    }
    this.warnIfCompiled(
      `Adding a node to a graph that has already been compiled. This will not be reflected in the compiled graph.`
    );

    if (key in this.nodes) {
      throw new Error(`Node \`${key}\` already present.`);
    }
    if (key === END || key === START) {
      throw new Error(`Node \`${key}\` is reserved.`);
    }

    if (options?.input !== undefined) {
      this._addSchema(options.input.spec);
    }
    const nodeSpec: StateGraphNodeSpec<S, U> = {
      runnable: _coerceToRunnable(action) as unknown as Runnable<S, U>,
      retryPolicy: options?.retryPolicy,
      metadata: options?.metadata,
      input: options?.input?.spec ?? this._schemaDefinition,
    };

    this.nodes[key as unknown as N] = nodeSpec;

    return this as StateGraph<SD, S, U, N | K, I, O>;
  }

  addEdge(startKey: typeof START | N | N[], endKey: N | typeof END): this {
    if (typeof startKey === "string") {
      return super.addEdge(startKey, endKey);
    }

    if (this.compiled) {
      console.warn(
        "Adding an edge to a graph that has already been compiled. This will " +
          "not be reflected in the compiled graph."
      );
    }

    for (const start of startKey) {
      if (start === END) {
        throw new Error("END cannot be a start node");
      }
      if (!Object.keys(this.nodes).some((node) => node === start)) {
        throw new Error(`Need to addNode ${start} first`);
      }
    }
    if (endKey === END) {
      throw new Error("END cannot be an end node");
    }
    if (!Object.keys(this.nodes).some((node) => node === endKey)) {
      throw new Error(`Need to addNode ${endKey} first`);
    }

    this.waitingEdges.add([startKey, endKey]);

    return this;
  }

  compile({
    checkpointer,
    store,
    interruptBefore,
    interruptAfter,
  }: {
    checkpointer?: BaseCheckpointSaver;
    store?: BaseStore;
    interruptBefore?: N[] | All;
    interruptAfter?: N[] | All;
  } = {}): CompiledStateGraph<S, U, N, I, O> {
    // validate the graph
    this.validate([
      ...(Array.isArray(interruptBefore) ? interruptBefore : []),
      ...(Array.isArray(interruptAfter) ? interruptAfter : []),
    ]);

    // prepare output channels
    const outputKeys = Object.keys(
      this._schemaDefinitions.get(this._outputDefinition)
    );
    const outputChannels =
      outputKeys.length === 1 && outputKeys[0] === ROOT ? ROOT : outputKeys;

    const streamKeys = Object.keys(this.channels);
    const streamChannels =
      streamKeys.length === 1 && streamKeys[0] === ROOT ? ROOT : streamKeys;

    // create empty compiled graph
    const compiled = new CompiledStateGraph<S, U, N, I, O>({
      builder: this,
      checkpointer,
      interruptAfter,
      interruptBefore,
      autoValidate: false,
      nodes: {} as Record<N | typeof START, PregelNode<S, U>>,
      channels: {
        ...this.channels,
        [START]: new EphemeralValue(),
      } as Record<N | typeof START | typeof END | string, BaseChannel>,
      inputChannels: START,
      outputChannels,
      streamChannels,
      streamMode: "updates",
      store,
    });

    // attach nodes, edges and branches
    compiled.attachNode(START);
    for (const [key, node] of Object.entries<StateGraphNodeSpec<S, U>>(
      this.nodes
    )) {
      compiled.attachNode(key as N, node);
    }
    for (const [start, end] of this.edges) {
      compiled.attachEdge(start, end);
    }
    for (const [starts, end] of this.waitingEdges) {
      compiled.attachEdge(starts, end);
    }
    for (const [start, branches] of Object.entries(this.branches)) {
      for (const [name, branch] of Object.entries(branches)) {
        compiled.attachBranch(start as N, name, branch);
      }
    }

    return compiled.validate();
  }
}

function _getChannels<Channels extends Record<string, unknown> | unknown>(
  schema: StateGraphArgs<Channels>["channels"]
): Record<string, BaseChannel> {
  const channels: Record<string, BaseChannel> = {};
  for (const [name, val] of Object.entries(schema)) {
    if (name === ROOT) {
      channels[name] = getChannel<Channels>(val as SingleReducer<Channels>);
    } else {
      const key = name as keyof Channels;
      channels[name] = getChannel<Channels[typeof key]>(
        val as SingleReducer<Channels[typeof key]>
      );
    }
  }
  return channels;
}

export class CompiledStateGraph<
  S,
  U,
  N extends string = typeof START,
  I extends StateDefinition = StateDefinition,
  O extends StateDefinition = StateDefinition
> extends CompiledGraph<N, S, U> {
  declare builder: StateGraph<unknown, S, U, N, I, O>;

  attachNode(key: typeof START, node?: never): void;

  attachNode(key: N, node: StateGraphNodeSpec<S, U>): void;

  attachNode(key: N | typeof START, node?: StateGraphNodeSpec<S, U>): void {
    const stateKeys = Object.keys(this.builder.channels);

    function getStateKey(key: keyof U, input: U) {
      if (!input) {
        return SKIP_WRITE;
      } else if (typeof input !== "object" || Array.isArray(input)) {
        const typeofInput = Array.isArray(input) ? "array" : typeof input;
        throw new InvalidUpdateError(`Expected object, got ${typeofInput}`);
      } else {
        return key in input ? input[key] : SKIP_WRITE;
      }
    }

    // state updaters
    const stateWriteEntries: ChannelWriteEntry[] = stateKeys.map((key) =>
      key === ROOT
        ? { channel: key, value: PASSTHROUGH, skipNone: true }
        : {
            channel: key,
            value: PASSTHROUGH,
            mapper: new RunnableCallable({
              func: getStateKey.bind(null, key as keyof U),
              trace: false,
              recurse: false,
            }),
          }
    );

    // add node and output channel
    if (key === START) {
      this.nodes[key] = new PregelNode<S, U>({
        tags: [TAG_HIDDEN],
        triggers: [START],
        channels: [START],
        writers: [new ChannelWrite(stateWriteEntries, [TAG_HIDDEN])],
      });
    } else {
      const inputDefinition = node?.input ?? this.builder._schemaDefinition;
      const inputValues = Object.fromEntries(
        Object.keys(this.builder._schemaDefinitions.get(inputDefinition)).map(
          (k) => [k, k]
        )
      );
      const isSingleInput =
        Object.keys(inputValues).length === 1 && ROOT in inputValues;
      this.channels[key] = new EphemeralValue(false);
      this.nodes[key] = new PregelNode<S, U>({
        triggers: [],
        // read state keys
        channels: isSingleInput ? Object.keys(inputValues) : inputValues,
        // publish to this channel and state keys
        writers: [
          new ChannelWrite(
            stateWriteEntries.concat({ channel: key, value: key }),
            [TAG_HIDDEN]
          ),
        ],
        mapper: isSingleInput
          ? undefined
          : // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (input: Record<string, any>) => {
              return Object.fromEntries(
                Object.entries(input).filter(([k]) => k in inputValues)
              );
            },
        bound: node?.runnable,
        metadata: node?.metadata,
        retryPolicy: node?.retryPolicy,
      });
    }
  }

  attachEdge(start: N | N[] | "__start__", end: N | "__end__"): void {
    if (end === END) {
      return;
    }
    if (Array.isArray(start)) {
      const channelName = `join:${start.join("+")}:${end}`;
      // register channel
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new NamedBarrierValue(new Set(start));
      // subscribe to channel
      this.nodes[end].triggers.push(channelName);
      // publish to channel
      for (const s of start) {
        this.nodes[s].writers.push(
          new ChannelWrite([{ channel: channelName, value: s }], [TAG_HIDDEN])
        );
      }
    } else if (start === START) {
      const channelName = `start:${end}`;
      // register channel
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new EphemeralValue();
      // subscribe to channel
      this.nodes[end].triggers.push(channelName);
      // publish to channel
      this.nodes[START].writers.push(
        new ChannelWrite([{ channel: channelName, value: START }], [TAG_HIDDEN])
      );
    } else {
      this.nodes[end].triggers.push(start);
    }
  }

  attachBranch(
    start: N | typeof START,
    name: string,
    branch: Branch<S, N>
  ): void {
    // attach branch publisher
    this.nodes[start].writers.push(
      branch.compile(
        // writer
        (dests) => {
          const filteredDests = dests.filter((dest) => dest !== END);
          if (!filteredDests.length) {
            return;
          }
          const writes: (ChannelWriteEntry | Send)[] = filteredDests.map(
            (dest) => {
              if (_isSend(dest)) {
                return dest;
              }
              return {
                channel: `branch:${start}:${name}:${dest}`,
                value: start,
              };
            }
          );
          return new ChannelWrite(writes, [TAG_HIDDEN]);
        },
        // reader
        (config) => ChannelRead.doRead<S>(config, this.outputChannels, true)
      )
    );

    // attach branch subscribers
    const ends = branch.ends
      ? Object.values(branch.ends)
      : Object.keys(this.builder.nodes);
    for (const end of ends) {
      if (end === END) {
        continue;
      }
      const channelName = `branch:${start}:${name}:${end}`;
      (this.channels as Record<string, BaseChannel>)[channelName] =
        new EphemeralValue(false);
      this.nodes[end as N].triggers.push(channelName);
    }
  }
}

function isBaseChannel(obj: unknown): obj is BaseChannel {
  return obj != null && typeof (obj as BaseChannel).lc_graph_name === "string";
}

function isStateDefinition(obj: unknown): obj is StateDefinition {
  return (
    typeof obj === "object" &&
    obj !== null &&
    !Array.isArray(obj) &&
    Object.keys(obj).length > 0 &&
    Object.values(obj).every((v) => typeof v === "function" || isBaseChannel(v))
  );
}

function isAnnotationRoot<SD extends StateDefinition>(
  obj: unknown | AnnotationRoot<SD>
): obj is AnnotationRoot<SD> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "lc_graph_name" in obj &&
    obj.lc_graph_name === "AnnotationRoot"
  );
}

function isStateGraphArgs<Channels extends object | unknown>(
  obj: unknown | StateGraphArgs<Channels>
): obj is StateGraphArgs<Channels> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as StateGraphArgs<Channels>).channels !== undefined
  );
}

function isStateGraphArgsWithStateSchema<
  SD extends StateDefinition,
  I extends StateDefinition,
  O extends StateDefinition
>(
  obj: unknown | StateGraphArgsWithStateSchema<SD, I, O>
): obj is StateGraphArgsWithStateSchema<SD, I, O> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    (obj as StateGraphArgsWithStateSchema<SD, I, O>).stateSchema !== undefined
  );
}

function isStateGraphArgsWithInputOutputSchemas<
  SD extends StateDefinition,
  O extends StateDefinition
>(
  obj: unknown | StateGraphArgsWithInputOutputSchemas<SD, O>
): obj is StateGraphArgsWithInputOutputSchemas<SD, O> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (obj as any).stateSchema === undefined &&
    (obj as StateGraphArgsWithInputOutputSchemas<SD, O>).input !== undefined &&
    (obj as StateGraphArgsWithInputOutputSchemas<SD, O>).output !== undefined
  );
}
