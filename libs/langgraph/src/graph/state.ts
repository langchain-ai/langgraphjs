/* eslint-disable @typescript-eslint/no-use-before-define */
import {
  _coerceToRunnable,
  Runnable,
  RunnableLike,
} from "@langchain/core/runnables";
import {
  All,
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import { BaseChannel, isBaseChannel } from "../channels/base.js";
import {
  CompiledGraph,
  Graph,
  Branch,
  AddNodeOptions,
  NodeSpec,
} from "./graph.js";
import {
  ChannelWrite,
  ChannelWriteEntry,
  ChannelWriteTupleEntry,
  PASSTHROUGH,
} from "../pregel/write.js";
import { ChannelRead, PregelNode } from "../pregel/read.js";
import { NamedBarrierValue } from "../channels/named_barrier_value.js";
import { EphemeralValue } from "../channels/ephemeral_value.js";
import { RunnableCallable } from "../utils.js";
import {
  isCommand,
  _isSend,
  CHECKPOINT_NAMESPACE_END,
  CHECKPOINT_NAMESPACE_SEPARATOR,
  Command,
  END,
  SELF,
  Send,
  START,
  TAG_HIDDEN,
} from "../constants.js";
import { InvalidUpdateError, ParentCommand } from "../errors.js";
import {
  AnnotationRoot,
  getChannel,
  SingleReducer,
  StateDefinition,
  StateType,
  UpdateType,
} from "./annotation.js";
import type { RetryPolicy } from "../pregel/utils/index.js";
import { isConfiguredManagedValue, ManagedValueSpec } from "../managed/base.js";
import type { LangGraphRunnableConfig } from "../pregel/runnable_types.js";
import { isPregelLike } from "../pregel/utils/subgraph.js";
import {
  AnyZodObject,
  getChannelsFromZod,
  isAnyZodObject,
  ZodToStateDefinition,
} from "./zod/state.js";

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

type ZodStateGraphArgsWithStateSchema<
  SD extends AnyZodObject,
  I extends SDZod,
  O extends SDZod
> = { state: SD; input?: I; output?: O };

type ZodStateGraphArgsWithIOSchema<I extends SDZod, O extends SDZod> = {
  input: I;
  output: O;
};

type SDZod = StateDefinition | AnyZodObject;

type ToStateDefinition<T> = T extends AnyZodObject
  ? ZodToStateDefinition<T>
  : T extends StateDefinition
  ? T
  : never;

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
  SD extends SDZod | unknown,
  S = SD extends SDZod ? StateType<ToStateDefinition<SD>> : SD,
  U = SD extends SDZod ? UpdateType<ToStateDefinition<SD>> : Partial<S>,
  N extends string = typeof START,
  I extends SDZod = SD extends SDZod ? ToStateDefinition<SD> : StateDefinition,
  O extends SDZod = SD extends SDZod ? ToStateDefinition<SD> : StateDefinition,
  C extends SDZod = StateDefinition
> extends Graph<N, S, U, StateGraphNodeSpec<S, U>, ToStateDefinition<C>> {
  channels: Record<string, BaseChannel | ManagedValueSpec> = {};

  // TODO: this doesn't dedupe edges as in py, so worth fixing at some point
  waitingEdges: Set<[N[], N]> = new Set();

  /** @internal */
  _schemaDefinition: StateDefinition;

  /** @internal */
  _schemaRuntimeDefinition: AnyZodObject | undefined;

  /** @internal */
  _inputDefinition: I;

  /** @internal */
  _inputRuntimeDefinition: AnyZodObject | undefined;

  /** @internal */
  _outputDefinition: O;

  /** @internal */
  _outputRuntimeDefinition: AnyZodObject | undefined;

  /**
   * Map schemas to managed values
   * @internal
   */
  _schemaDefinitions = new Map();

  /** @internal Used only for typing. */
  _configSchema: C | undefined;

  constructor(
    fields: SD extends StateDefinition
      ?
          | SD
          | AnnotationRoot<SD>
          | StateGraphArgs<S>
          | StateGraphArgsWithStateSchema<
              SD,
              ToStateDefinition<I>,
              ToStateDefinition<O>
            >
          | StateGraphArgsWithInputOutputSchemas<SD, ToStateDefinition<O>>
      : StateGraphArgs<S>,
    configSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  constructor(
    fields: SD extends AnyZodObject
      ?
          | SD
          | ZodStateGraphArgsWithIOSchema<I, O>
          | ZodStateGraphArgsWithStateSchema<SD, I, O>
      : never,
    configSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  constructor(
    fields: SD extends AnyZodObject
      ? SD | ZodStateGraphArgsWithStateSchema<SD, I, O>
      : SD extends StateDefinition
      ?
          | SD
          | AnnotationRoot<SD>
          | StateGraphArgs<S>
          | StateGraphArgsWithStateSchema<
              SD,
              ToStateDefinition<I>,
              ToStateDefinition<O>
            >
          | StateGraphArgsWithInputOutputSchemas<SD, ToStateDefinition<O>>
      : StateGraphArgs<S>,
    configSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  ) {
    super();

    if (isZodStateGraphArgsWithStateSchema(fields)) {
      const stateDef = getChannelsFromZod(fields.state);
      const inputDef =
        fields.input != null ? getChannelsFromZod(fields.input) : stateDef;
      const outputDef =
        fields.output != null ? getChannelsFromZod(fields.output) : stateDef;

      this._schemaDefinition = stateDef;
      this._schemaRuntimeDefinition = fields.state;

      this._inputDefinition = inputDef as I;
      this._inputRuntimeDefinition = fields.input ?? fields.state;

      this._outputDefinition = outputDef as O;
      this._outputRuntimeDefinition = fields.output ?? fields.state;
    } else if (isZodStateGraphArgsWithIOSchema(fields)) {
      const inputDef = getChannelsFromZod(fields.input);
      const outputDef = getChannelsFromZod(fields.output);

      this._schemaDefinition = inputDef;
      this._schemaRuntimeDefinition = fields.input;

      this._inputDefinition = inputDef as I;
      this._inputRuntimeDefinition = fields.input;

      this._outputDefinition = outputDef as O;
      this._outputRuntimeDefinition = fields.output;
    } else if (isAnyZodObject(fields)) {
      const stateDef = getChannelsFromZod(fields);

      this._schemaDefinition = stateDef;
      this._schemaRuntimeDefinition = fields;

      this._inputDefinition = stateDef as I;
      this._inputRuntimeDefinition = fields;

      this._outputDefinition = stateDef as O;
      this._outputRuntimeDefinition = fields;
    } else if (
      isStateGraphArgsWithInputOutputSchemas<
        SD extends StateDefinition ? SD : never,
        O extends StateDefinition ? O : never
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

    this._inputDefinition ??= this._schemaDefinition as I;
    this._outputDefinition ??= this._schemaDefinition as O;

    this._addSchema(this._schemaDefinition);
    this._addSchema(this._inputDefinition);
    this._addSchema(this._outputDefinition);

    this._configSchema =
      configSchema != null && "spec" in configSchema
        ? (configSchema.spec as C)
        : configSchema;
  }

  get allEdges(): Set<[string, string]> {
    return new Set([
      ...this.edges,
      ...Array.from(this.waitingEdges).flatMap(([starts, end]) =>
        starts.map((start) => [start, end] as [string, string])
      ),
    ]);
  }

  _addSchema(stateDefinition: SDZod) {
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
          if (
            !isConfiguredManagedValue(channel) &&
            channel.lc_graph_name !== "LastValue"
          ) {
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

  override addNode<K extends string, NodeInput = S>(
    key: K,
    action: RunnableLike<
      NodeInput,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      U extends object ? U & Record<string, any> : U,
      LangGraphRunnableConfig<StateType<ToStateDefinition<C>>>
    >,
    options?: StateGraphAddNodeOptions
  ): StateGraph<SD, S, U, N | K, I, O, C> {
    if (key in this.channels) {
      throw new Error(
        `${key} is already being used as a state attribute (a.k.a. a channel), cannot also be used as a node name.`
      );
    }

    for (const reservedChar of [
      CHECKPOINT_NAMESPACE_SEPARATOR,
      CHECKPOINT_NAMESPACE_END,
    ]) {
      if (key.includes(reservedChar)) {
        throw new Error(
          `"${reservedChar}" is a reserved character and is not allowed in node names.`
        );
      }
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

    let runnable;
    if (Runnable.isRunnable(action)) {
      runnable = action;
    } else if (typeof action === "function") {
      runnable = new RunnableCallable({
        func: action,
        name: key,
        trace: false,
      });
    } else {
      runnable = _coerceToRunnable(action);
    }
    const nodeSpec: StateGraphNodeSpec<S, U> = {
      runnable: runnable as unknown as Runnable<S, U>,
      retryPolicy: options?.retryPolicy,
      metadata: options?.metadata,
      input: options?.input?.spec ?? this._schemaDefinition,
      subgraphs: isPregelLike(runnable)
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [runnable as any]
        : options?.subgraphs,
      ends: options?.ends,
    };

    this.nodes[key as unknown as N] = nodeSpec;

    return this as StateGraph<SD, S, U, N | K, I, O, C>;
  }

  override addEdge(
    startKey: typeof START | N | N[],
    endKey: N | typeof END
  ): this {
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
        throw new Error(`Need to add a node named "${start}" first`);
      }
    }
    if (endKey === END) {
      throw new Error("END cannot be an end node");
    }
    if (!Object.keys(this.nodes).some((node) => node === endKey)) {
      throw new Error(`Need to add a node named "${endKey}" first`);
    }

    this.waitingEdges.add([startKey, endKey]);

    return this;
  }

  override compile({
    checkpointer,
    store,
    interruptBefore,
    interruptAfter,
    name,
  }: {
    checkpointer?: BaseCheckpointSaver | false;
    store?: BaseStore;
    interruptBefore?: N[] | All;
    interruptAfter?: N[] | All;
    name?: string;
  } = {}): CompiledStateGraph<S, U, N, I, O, C> {
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
    const compiled = new CompiledStateGraph<S, U, N, I, O, C>({
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
      name,
    });

    // attach nodes, edges and branches
    compiled.attachNode(START);
    for (const [key, node] of Object.entries<StateGraphNodeSpec<S, U>>(
      this.nodes
    )) {
      compiled.attachNode(key as N, node);
    }
    compiled.attachBranch(START, SELF, _getControlBranch() as Branch<S, N>, {
      withReader: false,
    });
    for (const [key] of Object.entries<StateGraphNodeSpec<S, U>>(this.nodes)) {
      compiled.attachBranch(
        key as N,
        SELF,
        _getControlBranch() as Branch<S, N>,
        {
          withReader: false,
        }
      );
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

/**
 * Final result from building and compiling a {@link StateGraph}.
 * Should not be instantiated directly, only using the StateGraph `.compile()`
 * instance method.
 */
export class CompiledStateGraph<
  S,
  U,
  N extends string = typeof START,
  I extends SDZod = StateDefinition,
  O extends SDZod = StateDefinition,
  C extends SDZod = StateDefinition
> extends CompiledGraph<
  N,
  S,
  U,
  StateType<ToStateDefinition<C>>,
  UpdateType<ToStateDefinition<I>>,
  StateType<ToStateDefinition<O>>
> {
  declare builder: StateGraph<unknown, S, U, N, I, O, C>;

  attachNode(key: typeof START, node?: never): void;

  attachNode(key: N, node: StateGraphNodeSpec<S, U>): void;

  attachNode(key: N | typeof START, node?: StateGraphNodeSpec<S, U>): void {
    let outputKeys: string[];
    if (key === START) {
      // Get input schema keys excluding managed values
      outputKeys = Object.entries(
        this.builder._schemaDefinitions.get(this.builder._inputDefinition)
      )
        .filter(([_, v]) => !isConfiguredManagedValue(v))
        .map(([k]) => k);
    } else {
      outputKeys = Object.keys(this.builder.channels);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function _getRoot(input: unknown): [string, any][] | null {
      if (isCommand(input)) {
        if (input.graph === Command.PARENT) {
          return null;
        }
        return input._updateAsTuples();
      } else if (
        Array.isArray(input) &&
        input.length > 0 &&
        input.some((i) => isCommand(i))
      ) {
        const updates: [string, unknown][] = [];
        for (const i of input) {
          if (isCommand(i)) {
            if (i.graph === Command.PARENT) {
              continue;
            }
            updates.push(...i._updateAsTuples());
          } else {
            updates.push([ROOT, i]);
          }
        }
        return updates;
      } else if (input != null) {
        return [[ROOT, input]];
      }
      return null;
    }

    // to avoid name collision below
    const nodeKey = key;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function _getUpdates(input: U): [string, any][] | null {
      if (!input) {
        return null;
      } else if (isCommand(input)) {
        if (input.graph === Command.PARENT) {
          return null;
        }
        return input._updateAsTuples().filter(([k]) => outputKeys.includes(k));
      } else if (
        Array.isArray(input) &&
        input.length > 0 &&
        input.some(isCommand)
      ) {
        const updates: [string, unknown][] = [];
        for (const item of input) {
          if (isCommand(item)) {
            if (item.graph === Command.PARENT) {
              continue;
            }
            updates.push(
              ...item._updateAsTuples().filter(([k]) => outputKeys.includes(k))
            );
          } else {
            const itemUpdates = _getUpdates(item);
            if (itemUpdates) {
              updates.push(...(itemUpdates ?? []));
            }
          }
        }
        return updates;
      } else if (typeof input === "object" && !Array.isArray(input)) {
        return Object.entries(input).filter(([k]) => outputKeys.includes(k));
      } else {
        const typeofInput = Array.isArray(input) ? "array" : typeof input;
        throw new InvalidUpdateError(
          `Expected node "${nodeKey.toString()}" to return an object or an array containing at least one Command object, received ${typeofInput}`,
          {
            lc_error_code: "INVALID_GRAPH_NODE_RETURN_VALUE",
          }
        );
      }
    }

    const stateWriteEntries: (ChannelWriteTupleEntry | ChannelWriteEntry)[] = [
      {
        value: PASSTHROUGH,
        mapper: new RunnableCallable({
          func:
            outputKeys.length && outputKeys[0] === ROOT
              ? _getRoot
              : _getUpdates,
          trace: false,
          recurse: false,
        }),
      },
    ];

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
        subgraphs: node?.subgraphs,
        ends: node?.ends,
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
      const channelName = `${START}:${end}`;
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
    branch: Branch<S, N>,
    options: { withReader?: boolean } = { withReader: true }
  ): void {
    const branchWriter = async (
      packets: (string | Send)[],
      config: LangGraphRunnableConfig
    ) => {
      const filteredPackets = packets.filter((p) => p !== END);
      if (!filteredPackets.length) {
        return;
      }
      const writes: (ChannelWriteEntry | Send)[] = filteredPackets.map((p) => {
        if (_isSend(p)) {
          return p;
        }
        return {
          channel: `branch:${start}:${name}:${p}`,
          value: start,
        };
      });
      await ChannelWrite.doWrite(
        { ...config, tags: (config.tags ?? []).concat([TAG_HIDDEN]) },
        writes
      );
    };
    // attach branch publisher
    this.nodes[start].writers.push(
      branch.run(
        branchWriter,
        // reader
        options.withReader
          ? (config) =>
              ChannelRead.doRead<S>(
                config,
                this.streamChannels ?? this.outputChannels,
                true
              )
          : undefined
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

function isZodStateGraphArgsWithStateSchema<
  SD extends AnyZodObject,
  I extends AnyZodObject,
  O extends AnyZodObject
>(value: unknown): value is ZodStateGraphArgsWithStateSchema<SD, I, O> {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  if (!("state" in value) || !isAnyZodObject(value.state)) {
    return false;
  }

  if ("input" in value && !isAnyZodObject(value.input)) {
    return false;
  }

  if ("output" in value && !isAnyZodObject(value.output)) {
    return false;
  }

  return true;
}

function isZodStateGraphArgsWithIOSchema<
  I extends AnyZodObject,
  O extends AnyZodObject
>(value: unknown): value is ZodStateGraphArgsWithIOSchema<I, O> {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  if ("state" in value && value.state != null) {
    return false;
  }

  if ("input" in value && !isAnyZodObject(value.input)) {
    return false;
  }

  if ("output" in value && !isAnyZodObject(value.output)) {
    return false;
  }

  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _controlBranch(value: any): (string | Send)[] {
  if (_isSend(value)) {
    return [value];
  }
  const commands = [];
  if (isCommand(value)) {
    commands.push(value);
  } else if (Array.isArray(value)) {
    commands.push(...value.filter(isCommand));
  }
  const destinations: (string | Send)[] = [];

  for (const command of commands) {
    if (command.graph === Command.PARENT) {
      throw new ParentCommand(command);
    }

    if (_isSend(command.goto)) {
      destinations.push(command.goto);
    } else if (typeof command.goto === "string") {
      destinations.push(command.goto);
    } else {
      if (Array.isArray(command.goto)) {
        destinations.push(...command.goto);
      }
    }
  }
  return destinations;
}

function _getControlBranch() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const CONTROL_BRANCH_PATH = new RunnableCallable<any, (string | Send)[]>({
    func: _controlBranch,
    tags: [TAG_HIDDEN],
    trace: false,
    recurse: false,
    name: "<control_branch>",
  });
  return new Branch({
    path: CONTROL_BRANCH_PATH,
  });
}
