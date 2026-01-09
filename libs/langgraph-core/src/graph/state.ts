/* eslint-disable @typescript-eslint/no-use-before-define */
import { _coerceToRunnable, Runnable } from "@langchain/core/runnables";
import {
  All,
  type BaseCache,
  BaseCheckpointSaver,
  BaseStore,
} from "@langchain/langgraph-checkpoint";
import {
  type InteropZodObject,
  interopParse,
  interopZodObjectPartial,
  isInteropZodObject,
} from "@langchain/core/utils/types";
import type {
  RunnableLike,
  LangGraphRunnableConfig,
  Runtime,
} from "../pregel/runnable_types.js";
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
import {
  NamedBarrierValue,
  NamedBarrierValueAfterFinish,
} from "../channels/named_barrier_value.js";
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
  CommandInstance,
  isInterrupted,
  Interrupt,
  INTERRUPT,
} from "../constants.js";
import {
  InvalidUpdateError,
  ParentCommand,
  StateGraphInputError,
} from "../errors.js";
import {
  AnnotationRoot,
  getChannel,
  SingleReducer,
  StateDefinition,
  StateType,
  UpdateType,
} from "./annotation.js";
import { StateSchema } from "../state/index.js";
import type { CachePolicy, RetryPolicy } from "../pregel/utils/index.js";
import { isPregelLike } from "../pregel/utils/subgraph.js";
import { LastValueAfterFinish } from "../channels/last_value.js";
import {
  type SchemaMetaRegistry,
  InteropZodToStateDefinition,
  schemaMetaRegistry,
} from "./zod/meta.js";
import type {
  InferInterruptResumeType,
  InferInterruptInputType,
} from "../interrupt.js";
import type { InferWriterType } from "../writer.js";

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
  cachePolicy?: CachePolicy;
};

export type StateGraphAddNodeOptions<Nodes extends string = string> = {
  retryPolicy?: RetryPolicy;
  cachePolicy?: CachePolicy | boolean;
  // TODO: Fix generic typing for annotations
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input?: AnnotationRoot<any> | InteropZodObject;
} & AddNodeOptions<Nodes>;

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
  SD extends InteropZodObject,
  I extends StateDefinitionInit,
  O extends StateDefinitionInit
> = { state: SD; input?: I; output?: O };

type StateDefinitionInit = StateDefinition | InteropZodObject | StateSchema;

type ToStateDefinition<T> = T extends StateSchema
  ? StateDefinition // StateSchema provides its own channels
  : T extends InteropZodObject
  ? InteropZodToStateDefinition<T>
  : T extends StateDefinition
  ? T
  : never;

/**
 * Extract State type from StateGraph-compatible schema types.
 *
 * For StateSchema: uses the declared State type directly
 * For StateDefinition/InteropZodObject: uses existing StateType mapping
 */
type ExtractStateType<T> = T extends StateSchema
  ? T["State"]
  : T extends StateDefinition
  ? StateType<T>
  : T extends InteropZodObject
  ? StateType<InteropZodToStateDefinition<T>>
  : T;

/**
 * Extract Update type from StateGraph-compatible schema types.
 */
type ExtractUpdateType<T, S> = T extends StateSchema
  ? T["Update"]
  : T extends StateDefinition
  ? UpdateType<T>
  : T extends InteropZodObject
  ? UpdateType<InteropZodToStateDefinition<T>>
  : Partial<S>;

type ExtractStateDefinition<T> = T extends StateSchema
  ? T // Keep StateSchema as-is to preserve type information
  : T extends StateDefinitionInit
  ? ToStateDefinition<T>
  : StateDefinition;

type NodeAction<
  S,
  U,
  C extends StateDefinitionInit,
  InterruptType,
  WriterType
> = RunnableLike<
  S,
  U extends object ? U & Record<string, any> : U, // eslint-disable-line @typescript-eslint/no-explicit-any
  Runtime<StateType<ToStateDefinition<C>>, InterruptType, WriterType>
>;

type StrictNodeAction<
  S,
  U,
  C extends StateDefinitionInit,
  Nodes extends string,
  InterruptType,
  WriterType
> = RunnableLike<
  Prettify<S>,
  | U
  | Command<
      InferInterruptResumeType<InterruptType>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      U & Record<string, any>,
      Nodes
    >,
  Runtime<StateType<ToStateDefinition<C>>, InterruptType, WriterType>
>;

const PartialStateSchema = Symbol.for("langgraph.state.partial");
type PartialStateSchema = typeof PartialStateSchema;

type MergeReturnType<Prev, Curr> = Prev & Curr extends infer T
  ? { [K in keyof T]: T[K] } & unknown
  : never;

type Prettify<T> = {
  [K in keyof T]: T[K];
  // eslint-disable-next-line @typescript-eslint/ban-types
} & {};

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
  SD extends StateDefinitionInit | unknown,
  S = ExtractStateType<SD>,
  U = ExtractUpdateType<SD, S>,
  N extends string = typeof START,
  I extends StateDefinitionInit = ExtractStateDefinition<SD>,
  O extends StateDefinitionInit = ExtractStateDefinition<SD>,
  C extends StateDefinitionInit = StateDefinition,
  NodeReturnType = unknown,
  InterruptType = unknown,
  WriterType = unknown
> extends Graph<N, S, U, StateGraphNodeSpec<S, U>, ToStateDefinition<C>> {
  channels: Record<string, BaseChannel> = {};

  // TODO: this doesn't dedupe edges as in py, so worth fixing at some point
  waitingEdges: Set<[N[], N]> = new Set();

  /** @internal */
  _schemaDefinition: StateDefinition;

  /** @internal */
  _schemaRuntimeDefinition: InteropZodObject | StateSchema | undefined;

  /** @internal */
  _inputDefinition: I;

  /** @internal */
  _inputRuntimeDefinition:
    | InteropZodObject
    | StateSchema
    | PartialStateSchema
    | undefined;

  /** @internal */
  _outputDefinition: O;

  /** @internal */
  _outputRuntimeDefinition: InteropZodObject | StateSchema | undefined;

  /**
   * Map schemas to managed values
   * @internal
   */
  _schemaDefinitions = new Map();

  /** @internal */
  _metaRegistry: SchemaMetaRegistry = schemaMetaRegistry;

  /** @internal Used only for typing. */
  _configSchema: ToStateDefinition<C> | undefined;

  /** @internal */
  _configRuntimeSchema: InteropZodObject | undefined;

  /** @internal */
  _interrupt: InterruptType;

  /** @internal */
  _writer: WriterType;

  declare Node: StrictNodeAction<S, U, C, N, InterruptType, WriterType>;

  constructor(
    state: SD extends StateDefinition ? AnnotationRoot<SD> : never,
    options?: {
      context?: C | AnnotationRoot<ToStateDefinition<C>>;
      input?: I | AnnotationRoot<ToStateDefinition<I>>;
      output?: O | AnnotationRoot<ToStateDefinition<O>>;

      interrupt?: InterruptType;
      writer?: WriterType;

      nodes?: N[];
    }
  );

  constructor(
    state: SD extends StateSchema ? SD : never,
    options?: {
      context?: C | AnnotationRoot<ToStateDefinition<C>>;
      input?: I | AnnotationRoot<ToStateDefinition<I>>;
      output?: O | AnnotationRoot<ToStateDefinition<O>>;

      interrupt?: InterruptType;
      writer?: WriterType;

      nodes?: N[];
    }
  );

  constructor(
    state: SD extends InteropZodObject ? SD : never,
    options?: {
      context?: C | AnnotationRoot<ToStateDefinition<C>>;
      input?: I | AnnotationRoot<ToStateDefinition<I>>;
      output?: O | AnnotationRoot<ToStateDefinition<O>>;

      interrupt?: InterruptType;
      writer?: WriterType;

      nodes?: N[];
    }
  );

  constructor(
    fields: SD extends StateDefinition
      ? StateGraphArgsWithInputOutputSchemas<SD, ToStateDefinition<O>>
      : never,
    contextSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  constructor(
    fields: SD extends StateDefinition
      ?
          | AnnotationRoot<SD>
          | StateGraphArgsWithStateSchema<
              SD,
              ToStateDefinition<I>,
              ToStateDefinition<O>
            >
      : never,
    contextSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  /** @deprecated Use `Annotation.Root` or `zod` for state definition instead. */
  constructor(
    fields: SD extends StateDefinition
      ? SD | StateGraphArgs<S>
      : StateGraphArgs<S>,
    contextSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  constructor(
    fields: SD extends InteropZodObject
      ? SD | ZodStateGraphArgsWithStateSchema<SD, I, O>
      : never,
    contextSchema?: C | AnnotationRoot<ToStateDefinition<C>>
  );

  constructor(
    fields: SD extends StateSchema
      ? SD
      : SD extends InteropZodObject
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
    contextSchema?:
      | C
      | AnnotationRoot<ToStateDefinition<C>>
      | {
          input?: I | AnnotationRoot<ToStateDefinition<I>>;
          output?: O | AnnotationRoot<ToStateDefinition<O>>;
          context?: C | AnnotationRoot<ToStateDefinition<C>>;
          interrupt?: InterruptType;
          writer?: WriterType;
          nodes?: N[];
        }
  ) {
    super();

    if (StateSchema.isInstance(fields)) {
      const channels = fields.getChannels();
      this._schemaDefinition = channels;
      this.channels = channels;

      this._schemaRuntimeDefinition = fields;
      this._inputRuntimeDefinition = PartialStateSchema;
      this._outputRuntimeDefinition = fields;
    } else if (isZodStateGraphArgsWithStateSchema(fields)) {
      const stateDef = this._metaRegistry.getChannelsForSchema(fields.state);
      const inputDef =
        fields.input != null
          ? this._metaRegistry.getChannelsForSchema(fields.input)
          : stateDef;
      const outputDef =
        fields.output != null
          ? this._metaRegistry.getChannelsForSchema(fields.output)
          : stateDef;

      this._schemaDefinition = stateDef;
      this._schemaRuntimeDefinition = fields.state;

      this._inputDefinition = inputDef as I;
      this._inputRuntimeDefinition = fields.input ?? PartialStateSchema;

      this._outputDefinition = outputDef as O;
      this._outputRuntimeDefinition = fields.output ?? fields.state;
    } else if (isInteropZodObject(fields)) {
      const stateDef = this._metaRegistry.getChannelsForSchema(fields);

      this._schemaDefinition = stateDef;
      this._schemaRuntimeDefinition = fields;

      this._inputDefinition = stateDef as I;
      this._inputRuntimeDefinition = PartialStateSchema;

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
      throw new StateGraphInputError();
    }

    this._inputDefinition ??= this._schemaDefinition as I;
    this._outputDefinition ??= this._schemaDefinition as O;

    this._addSchema(this._schemaDefinition);
    this._addSchema(this._inputDefinition);
    this._addSchema(this._outputDefinition);

    function isOptions(options: unknown): options is {
      context?: C | AnnotationRoot<ToStateDefinition<C>>;
      input?: I | AnnotationRoot<ToStateDefinition<I>>;
      output?: O | AnnotationRoot<ToStateDefinition<O>>;
      interrupt?: InterruptType;
      writer?: WriterType;
      nodes?: N[];
    } {
      return (
        typeof options === "object" &&
        options != null &&
        !("spec" in options) &&
        !isInteropZodObject(options)
      );
    }

    // Handle runtime config options
    if (isOptions(contextSchema)) {
      if (isInteropZodObject(contextSchema.context)) {
        this._configRuntimeSchema = contextSchema.context;
      }
      this._interrupt = contextSchema.interrupt as InterruptType;
      this._writer = contextSchema.writer as WriterType;
    } else if (isInteropZodObject(contextSchema)) {
      this._configRuntimeSchema = contextSchema;
    }
  }

  get allEdges(): Set<[string, string]> {
    return new Set([
      ...this.edges,
      ...Array.from(this.waitingEdges).flatMap(([starts, end]) =>
        starts.map((start) => [start, end] as [string, string])
      ),
    ]);
  }

  _addSchema(stateDefinition: StateDefinitionInit) {
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

  override addNode<
    K extends string,
    NodeMap extends Record<K, NodeAction<S, U, C, InterruptType, WriterType>>
  >(
    nodes: NodeMap
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<
      NodeReturnType,
      {
        [key in keyof NodeMap]: NodeMap[key] extends NodeAction<
          S,
          infer U,
          C,
          InterruptType,
          WriterType
        >
          ? U
          : never;
      }
    >
  >;

  override addNode<K extends string, NodeInput = S, NodeOutput extends U = U>(
    nodes:
      | [
          key: K,
          action: NodeAction<
            NodeInput,
            NodeOutput,
            C,
            InterruptType,
            WriterType
          >,
          options?: StateGraphAddNodeOptions
        ][]
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<NodeReturnType, { [key in K]: NodeOutput }>
  >;

  override addNode<K extends string, NodeInput = S, NodeOutput extends U = U>(
    key: K,
    action: NodeAction<NodeInput, NodeOutput, C, InterruptType, WriterType>,
    options?: StateGraphAddNodeOptions
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<NodeReturnType, { [key in K]: NodeOutput }>
  >;

  override addNode<K extends string, NodeInput = S>(
    key: K,
    action: NodeAction<NodeInput, U, C, InterruptType, WriterType>,
    options?: StateGraphAddNodeOptions
  ): StateGraph<SD, S, U, N | K, I, O, C, NodeReturnType>;

  override addNode<K extends string, NodeInput = S, NodeOutput extends U = U>(
    ...args:
      | [
          key: K,
          action: NodeAction<
            NodeInput,
            NodeOutput,
            C,
            InterruptType,
            WriterType
          >,
          options?: StateGraphAddNodeOptions
        ]
      | [
          nodes:
            | Record<K, NodeAction<NodeInput, U, C, InterruptType, WriterType>>
            | [
                key: K,
                action: NodeAction<NodeInput, U, C, InterruptType, WriterType>,
                options?: StateGraphAddNodeOptions
              ][]
        ]
  ): StateGraph<SD, S, U, N | K, I, O, C> {
    function isMultipleNodes(
      args: unknown[]
    ): args is [
      nodes:
        | Record<K, NodeAction<NodeInput, U, C, InterruptType, WriterType>>
        | [
            key: K,
            action: NodeAction<NodeInput, U, C, InterruptType, WriterType>,
            options?: AddNodeOptions
          ][]
    ] {
      return args.length >= 1 && typeof args[0] !== "string";
    }

    const nodes = (
      isMultipleNodes(args) // eslint-disable-line no-nested-ternary
        ? Array.isArray(args[0])
          ? args[0]
          : Object.entries(args[0]).map(([key, action]) => [key, action])
        : [[args[0], args[1], args[2]]]
    ) as [
      K,
      NodeAction<NodeInput, U, C, InterruptType, WriterType>,
      StateGraphAddNodeOptions | undefined
    ][];

    if (nodes.length === 0) {
      throw new Error("No nodes provided in `addNode`");
    }

    for (const [key, action, options] of nodes) {
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

      let inputSpec = this._schemaDefinition;
      if (options?.input !== undefined) {
        if (isInteropZodObject(options.input)) {
          inputSpec = this._metaRegistry.getChannelsForSchema(options.input);
        } else if (options.input.spec !== undefined) {
          inputSpec = options.input.spec;
        }
      }
      if (inputSpec !== undefined) {
        this._addSchema(inputSpec);
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

      let cachePolicy = options?.cachePolicy;
      if (typeof cachePolicy === "boolean") {
        cachePolicy = cachePolicy ? {} : undefined;
      }

      const nodeSpec: StateGraphNodeSpec<S, U> = {
        runnable: runnable as unknown as Runnable<S, U>,
        retryPolicy: options?.retryPolicy,
        cachePolicy,
        metadata: options?.metadata,
        input: inputSpec ?? this._schemaDefinition,
        subgraphs: isPregelLike(runnable)
          ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
            [runnable as any]
          : options?.subgraphs,
        ends: options?.ends,
        defer: options?.defer,
      };

      this.nodes[key as unknown as N] = nodeSpec;
    }

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

  addSequence<K extends string, NodeInput = S, NodeOutput extends U = U>(
    nodes: [
      key: K,
      action: NodeAction<NodeInput, NodeOutput, C, InterruptType, WriterType>,
      options?: StateGraphAddNodeOptions
    ][]
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<NodeReturnType, { [key in K]: NodeOutput }>
  >;

  addSequence<
    K extends string,
    NodeMap extends Record<K, NodeAction<S, U, C, InterruptType, WriterType>>
  >(
    nodes: NodeMap
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<
      NodeReturnType,
      {
        [key in keyof NodeMap]: NodeMap[key] extends NodeAction<
          S,
          infer U,
          C,
          InterruptType,
          WriterType
        >
          ? U
          : never;
      }
    >
  >;

  addSequence<K extends string, NodeInput = S, NodeOutput extends U = U>(
    nodes:
      | [
          key: K,
          action: NodeAction<
            NodeInput,
            NodeOutput,
            C,
            InterruptType,
            WriterType
          >,
          options?: StateGraphAddNodeOptions
        ][]
      | Record<
          K,
          NodeAction<NodeInput, NodeOutput, C, InterruptType, WriterType>
        >
  ): StateGraph<
    SD,
    S,
    U,
    N | K,
    I,
    O,
    C,
    MergeReturnType<NodeReturnType, { [key in K]: NodeOutput }>
  > {
    const parsedNodes = Array.isArray(nodes) ? nodes : Object.entries(nodes);

    if (parsedNodes.length === 0) {
      throw new Error("Sequence requires at least one node.");
    }

    let previousNode: N | undefined;
    for (const [key, action, options] of parsedNodes) {
      if (key in this.nodes) {
        throw new Error(
          `Node names must be unique: node with the name "${key}" already exists.`
        );
      }

      const validKey = key as unknown as N;
      this.addNode(
        validKey,
        action as NodeAction<S, U, C, InterruptType, WriterType>,
        options
      );
      if (previousNode != null) {
        this.addEdge(previousNode, validKey);
      }

      previousNode = validKey;
    }

    return this as StateGraph<
      SD,
      S,
      U,
      N | K,
      I,
      O,
      C,
      MergeReturnType<NodeReturnType, { [key in K]: NodeOutput }>
    >;
  }

  override compile({
    checkpointer,
    store,
    cache,
    interruptBefore,
    interruptAfter,
    name,
    description,
  }: {
    checkpointer?: BaseCheckpointSaver | boolean;
    store?: BaseStore;
    cache?: BaseCache;
    interruptBefore?: N[] | All;
    interruptAfter?: N[] | All;
    name?: string;
    description?: string;
  } = {}): CompiledStateGraph<
    Prettify<S>,
    Prettify<U>,
    N,
    I,
    O,
    C,
    NodeReturnType,
    InterruptType,
    WriterType
  > {
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

    const userInterrupt = this._interrupt;
    // create empty compiled graph
    const compiled = new CompiledStateGraph<
      S,
      U,
      N,
      I,
      O,
      C,
      NodeReturnType,
      InterruptType,
      WriterType
    >({
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
      cache,
      name,
      description,
      userInterrupt,
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
  I extends StateDefinitionInit = StateDefinition,
  O extends StateDefinitionInit = StateDefinition,
  C extends StateDefinitionInit = StateDefinition,
  NodeReturnType = unknown,
  InterruptType = unknown,
  WriterType = unknown
> extends CompiledGraph<
  N,
  S,
  U,
  ExtractStateType<C>,
  ExtractUpdateType<I, ExtractStateType<I>>,
  ExtractStateType<O>,
  NodeReturnType,
  CommandInstance<InferInterruptResumeType<InterruptType>, Prettify<U>, N>,
  InferWriterType<WriterType>
> {
  declare builder: StateGraph<unknown, S, U, N, I, O, C, NodeReturnType>;

  /**
   * The description of the compiled graph.
   * This is used by the supervisor agent to describe the handoff to the agent.
   */
  description?: string;

  /** @internal */
  _metaRegistry: SchemaMetaRegistry = schemaMetaRegistry;

  constructor({
    description,
    ...rest
  }: { description?: string } & ConstructorParameters<
    typeof CompiledGraph<
      N,
      S,
      U,
      ExtractStateType<C>,
      ExtractUpdateType<I, ExtractStateType<I>>,
      ExtractStateType<O>,
      NodeReturnType,
      CommandInstance<InferInterruptResumeType<InterruptType>, Prettify<U>, N>,
      InferWriterType<WriterType>
    >
  >[0]) {
    super(rest);
    this.description = description;
  }

  attachNode(key: typeof START, node?: never): void;

  attachNode(key: N, node: StateGraphNodeSpec<S, U>): void;

  attachNode(key: N | typeof START, node?: StateGraphNodeSpec<S, U>): void {
    let outputKeys: string[];
    if (key === START) {
      // Get input schema keys excluding managed values
      outputKeys = Object.entries(
        this.builder._schemaDefinitions.get(this.builder._inputDefinition)
      ).map(([k]) => k);
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
      const branchChannel = `branch:to:${key}` as string | N;
      this.channels[branchChannel] = node?.defer
        ? new LastValueAfterFinish()
        : new EphemeralValue(false);
      this.nodes[key] = new PregelNode<S, U>({
        triggers: [branchChannel],
        // read state keys
        channels: isSingleInput ? Object.keys(inputValues) : inputValues,
        // publish to state keys
        writers: [new ChannelWrite(stateWriteEntries, [TAG_HIDDEN])],
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
        cachePolicy: node?.cachePolicy,
        subgraphs: node?.subgraphs,
        ends: node?.ends,
      });
    }
  }

  attachEdge(starts: N | N[] | "__start__", end: N | "__end__"): void {
    if (end === END) return;
    if (typeof starts === "string") {
      this.nodes[starts].writers.push(
        new ChannelWrite(
          [{ channel: `branch:to:${end}`, value: null }],
          [TAG_HIDDEN]
        )
      );
    } else if (Array.isArray(starts)) {
      const channelName = `join:${starts.join("+")}:${end}`;
      // register channel
      this.channels[channelName as string | N] = this.builder.nodes[end].defer
        ? new NamedBarrierValueAfterFinish(new Set(starts))
        : new NamedBarrierValue(new Set(starts));
      // subscribe to channel
      this.nodes[end].triggers.push(channelName);
      // publish to channel
      for (const start of starts) {
        this.nodes[start].writers.push(
          new ChannelWrite(
            [{ channel: channelName, value: start }],
            [TAG_HIDDEN]
          )
        );
      }
    }
  }

  attachBranch(
    start: N | typeof START,
    _: string,
    branch: Branch<S, N>,
    options: { withReader?: boolean } = { withReader: true }
  ): void {
    const branchWriter = async (
      packets: (string | Send)[],
      config: LangGraphRunnableConfig
    ) => {
      const filteredPackets = packets.filter((p) => p !== END);
      if (!filteredPackets.length) return;

      const writes: (ChannelWriteEntry | Send)[] = filteredPackets.map((p) => {
        if (_isSend(p)) return p;
        return { channel: p === END ? p : `branch:to:${p}`, value: start };
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
  }

  protected async _validateInput(
    input: ExtractUpdateType<I, ExtractStateType<I>>
  ): Promise<ExtractUpdateType<I, ExtractStateType<I>>> {
    if (input == null) return input;

    const inputDef = this.builder._inputRuntimeDefinition;
    const schemaDef = this.builder._schemaRuntimeDefinition;

    // Handle StateSchema validation
    if (StateSchema.isInstance(schemaDef)) {
      if (isCommand(input)) {
        const parsedInput = input;
        if (input.update) {
          parsedInput.update = await schemaDef.validateInput(
            Array.isArray(input.update)
              ? Object.fromEntries(input.update)
              : input.update
          );
        }
        return parsedInput;
      }
      return await schemaDef.validateInput(input);
    }

    // Handle InteropZodObject validation
    const schema = (() => {
      const apply = (schema: InteropZodObject | undefined) => {
        if (schema == null) return undefined;
        return this._metaRegistry.getExtendedChannelSchemas(schema, {
          withReducerSchema: true,
        });
      };

      if (isInteropZodObject(inputDef)) return apply(inputDef);
      if (inputDef === PartialStateSchema) {
        if (isInteropZodObject(schemaDef)) {
          return interopZodObjectPartial(apply(schemaDef)!);
        }
        return undefined;
      }
      return undefined;
    })();

    if (isCommand(input)) {
      const parsedInput = input;
      if (input.update && schema != null)
        parsedInput.update = interopParse(schema, input.update);
      return parsedInput;
    }
    if (schema != null) return interopParse(schema, input);
    return input;
  }

  public isInterrupted(input: unknown): input is {
    [INTERRUPT]: Interrupt<InferInterruptInputType<InterruptType>>[];
  } {
    return isInterrupted(input);
  }

  protected async _validateContext(
    config: Partial<Record<string, unknown>>
  ): Promise<Partial<Record<string, unknown>>> {
    const configSchema = this.builder._configRuntimeSchema;
    if (isInteropZodObject(configSchema)) interopParse(configSchema, config);
    return config;
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
  SD extends InteropZodObject,
  I extends InteropZodObject,
  O extends InteropZodObject
>(value: unknown): value is ZodStateGraphArgsWithStateSchema<SD, I, O> {
  if (typeof value !== "object" || value == null) {
    return false;
  }

  if (!("state" in value) || !isInteropZodObject(value.state)) {
    return false;
  }

  if ("input" in value && !isInteropZodObject(value.input)) {
    return false;
  }

  if ("output" in value && !isInteropZodObject(value.output)) {
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
