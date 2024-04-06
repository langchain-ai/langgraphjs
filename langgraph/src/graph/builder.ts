import { RunnableLike } from "@langchain/core/runnables";
import { END, Graph } from "./graph.js";
import { Pregel } from "../pregel/index.js";
import { BaseCheckpointSaver } from "../checkpoint/index.js";
import { START, StateGraph } from "./state.js";

/**
 * @experimental This class is experimental
 */
export class GraphBuilder<
  RunInput = unknown,
  RunOutput = unknown,
  const Nodes extends string = typeof END,
  Compiled extends true | void = undefined
> extends Graph<RunInput, RunOutput> {
  private strictCompiled: Compiled;

  private compileResult: Compiled extends true ? Pregel : never;

  // Adds a node to the graph and returns a builder that's aware of that nodes existence
  addNode<K extends string>(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    key: K,
    action: RunnableLike<RunInput, RunOutput>
  ): GraphBuilder<RunInput, RunOutput, Nodes | K> {
    super.addNode(key, action);
    return this;
  }

  // `startKey` and `endKey` must be existing node keys
  addEdge<SK extends Nodes, EK extends Nodes>(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    startKey: SK,
    endKey: EK
  ): GraphBuilder<RunInput, RunOutput, Nodes> {
    super.addEdge(startKey, endKey);
    return this;
  }

  // `startKey` and return key of `condition` must be existing node keys
  addConditionalEdges<SK extends Nodes>(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    startKey: SK,
    condition: (...args: unknown[]) => PromiseLike<Nodes> | Nodes
  ): GraphBuilder<RunInput, RunOutput, Nodes>;

  // `startKey` and all values in `conditionalEdgeMapping` must be existing node keys
  addConditionalEdges<
    SK extends Nodes,
    const EK extends Nodes,
    const Choices extends string
  >(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    startKey: SK,
    condition: (...args: unknown[]) => PromiseLike<Choices> | Choices,
    conditionalEdgeMapping: Record<Choices, EK>
  ): GraphBuilder<RunInput, RunOutput, Nodes>;

  addConditionalEdges<
    SK extends Nodes,
    const EK extends Nodes,
    const Choices extends string,
    const Mapping extends undefined | Record<Choices, EK>
  >(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    startKey: SK,
    condition: (
      ...args: unknown[]
    ) => Mapping extends undefined ? Nodes : PromiseLike<Choices> | Choices,
    conditionalEdgeMapping?: Mapping
  ): GraphBuilder<RunInput, RunOutput, Nodes> {
    super.addConditionalEdges(startKey, condition, conditionalEdgeMapping);
    return this;
  }

  // `key` must be an existing node key
  setEntryPoint<SK extends Nodes>(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    key: SK
  ): GraphBuilder<RunInput, RunOutput, Nodes> {
    super.setEntryPoint(key);
    return this;
  }

  // `key` must be an existing node key
  setFinishPoint<EK extends Nodes>(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    key: EK
  ): GraphBuilder<RunInput, RunOutput, Nodes> {
    super.setFinishPoint(key);
    return this;
  }

  // Puts the builder into a completed state
  done(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    checkpointer?: BaseCheckpointSaver
  ): GraphBuilder<RunInput, RunOutput, Nodes, true> {
    const that = this as unknown as GraphBuilder<
      RunInput,
      RunOutput,
      Nodes,
      true
    >;
    that.strictCompiled = true;
    that.compileResult = super.compile(checkpointer);
    return that;
  }

  // Unless we have called .done(), compile will throw, this is communicated at
  // the type-level by the return type of `never`
  compile(
    this: GraphBuilder<RunInput, RunOutput, Nodes>,
    ...args: Parameters<Graph<RunInput, RunOutput>["compile"]>
  ): never;

  // Builder instances which have been completed with .done() result in the
  // expected `Pregel` return type
  compile(
    this: GraphBuilder<RunInput, RunOutput, Nodes, true>,
    ...args: Parameters<Graph<RunInput, RunOutput>["compile"]>
  ): Pregel;

  compile(this: GraphBuilder<RunInput, RunOutput, Nodes, true | void>): Pregel {
    if (this.strictCompiled) {
      return this.compileResult;
    } else {
      throw new Error("Compilation not set");
    }
  }
}

/**
 * @experimental This class is experimental
 */
export class StateGraphBuilder<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Channels extends Record<string, unknown>,
  const Nodes extends string = typeof START | typeof END,
  Compiled extends true | void = undefined
> extends StateGraph<Channels> {
  private strictCompiled: Compiled;

  private compileResult: Compiled extends true ? Pregel : never;

  // Adds a node to the graph and returns a builder that's aware of that nodes existence
  addNode<K extends string>(
    this: StateGraphBuilder<Channels, Nodes>,
    key: K,
    action: RunnableLike<Channels>
  ): StateGraphBuilder<Channels, Nodes | K> {
    super.addNode(key, action);
    return this;
  }

  // `startKey` and `endKey` must be existing node keys
  addEdge<SK extends Nodes, EK extends Nodes>(
    this: StateGraphBuilder<Channels, Nodes>,
    startKey: SK,
    endKey: EK
  ): StateGraphBuilder<Channels, Nodes> {
    super.addEdge(startKey, endKey);
    return this;
  }

  // `startKey` and return key of `condition` must be existing node keys
  addConditionalEdges<SK extends Nodes>(
    this: StateGraphBuilder<Channels, Nodes>,
    startKey: SK,
    condition: (...args: unknown[]) => PromiseLike<Nodes> | Nodes
  ): StateGraphBuilder<Channels, Nodes>;

  // `startKey` and all values in `conditionalEdgeMapping` must be existing node keys
  addConditionalEdges<
    SK extends Nodes,
    const EK extends Nodes,
    const Choices extends string
  >(
    this: StateGraphBuilder<Channels, Nodes>,
    startKey: SK,
    condition: (...args: unknown[]) => PromiseLike<Choices> | Choices,
    conditionalEdgeMapping: Record<Choices, EK>
  ): StateGraphBuilder<Channels, Nodes>;

  addConditionalEdges<
    SK extends Nodes,
    const EK extends Nodes,
    const Choices extends string,
    const Mapping extends undefined | Record<Choices, EK>
  >(
    this: StateGraphBuilder<Channels, Nodes>,
    startKey: SK,
    condition: (
      ...args: unknown[]
    ) => Mapping extends undefined ? Nodes : PromiseLike<Choices> | Choices,
    conditionalEdgeMapping?: Mapping
  ): StateGraphBuilder<Channels, Nodes> {
    super.addConditionalEdges(startKey, condition, conditionalEdgeMapping);
    return this;
  }

  // `key` must be an existing node key
  setEntryPoint<SK extends Nodes>(
    this: StateGraphBuilder<Channels, Nodes>,
    key: SK
  ): StateGraphBuilder<Channels, Nodes> {
    super.setEntryPoint(key);
    return this;
  }

  // `key` must be an existing node key
  setFinishPoint<EK extends Nodes>(
    this: StateGraphBuilder<Channels, Nodes>,
    key: EK
  ): StateGraphBuilder<Channels, Nodes> {
    super.setFinishPoint(key);
    return this;
  }

  // Puts the builder into a completed state
  done(
    this: StateGraphBuilder<Channels, Nodes>,
    checkpointer?: BaseCheckpointSaver
  ): StateGraphBuilder<Channels, Nodes, true> {
    const that = this as unknown as StateGraphBuilder<Channels, Nodes, true>;
    that.strictCompiled = true;
    that.compileResult = super.compile(checkpointer);
    return that;
  }

  // Unless we have called .done(), compile will throw, this is communicated at
  // the type-level by the return type of `never`
  compile(
    this: StateGraphBuilder<Channels, Nodes>,
    ...args: Parameters<Graph<Channels>["compile"]>
  ): never;

  // Builder instances which have been completed with .done() result in the
  // expected `Pregel` return type
  compile(
    this: StateGraphBuilder<Channels, Nodes, true>,
    ...args: Parameters<Graph<Channels>["compile"]>
  ): Pregel;

  compile(this: StateGraphBuilder<Channels, Nodes, true | void>): Pregel {
    if (this.strictCompiled) {
      return this.compileResult;
    } else {
      throw new Error("Compilation not set");
    }
  }
}
