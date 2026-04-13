/**
 * GraphRunStream and SubgraphRunStream — the public run stream classes.
 *
 * Built-in projections:
 *   .subgraphs     — recursive child subgraph discovery
 *   .values        — state snapshots (AsyncIterable & PromiseLike)
 *   .messages      — per-message ChatModelStream lifecycle
 *   .messagesFrom  — node-filtered messages
 *   .output        — final state Promise
 *   .interrupted   — whether the run ended due to an interrupt
 *   .interrupts    — interrupt payloads
 *   .abort()       — programmatic cancellation
 *   .extensions    — merged transformer projections
 */

import type { StreamChunk } from "../pregel/stream.js";
import { EventLog } from "./event-log.js";
import { StreamMux, setRunStreamClasses, pump } from "./mux.js";
import { createMessagesReducer, createValuesReducer } from "./reducers.js";
import type {
  ChatModelStream,
  InferExtensions,
  InterruptPayload,
  Namespace,
  ProtocolEvent,
  StreamTransformer,
} from "./types.js";

/**
 * Primary run stream for a LangGraph execution.
 *
 * Implements {@link AsyncIterable} over {@link ProtocolEvent} and exposes
 * ergonomic projections for values, messages, subgraphs, output, and
 * interrupts. Created by {@link createGraphRunStream}.
 *
 * @typeParam TValues - Shape of the graph's state values.
 * @typeParam TExtensions - Shape of additional transformer projections merged
 *   into {@link GraphRunStream.extensions}.
 */
export class GraphRunStream<
  TValues = Record<string, unknown>,
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> implements AsyncIterable<ProtocolEvent> {
  /**
   * Namespace path identifying this stream's position in the agent tree.
   * An empty array for the root stream.
   */
  readonly path: Namespace;

  /**
   * Merged projections from user-supplied {@link StreamTransformer} factories.
   * Each transformer's `init()` return value is spread into this object.
   */
  readonly extensions: TExtensions;

  /**
   * The central stream multiplexer that drives event dispatch and transformer
   * pipelines. Accessible to subclasses for direct event subscription.
   *
   * @internal
   */
  protected readonly _mux: StreamMux;

  #eventStart: number;
  #discoveryStart: number;
  #abortController: AbortController;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  #resolveValuesFn?: (v: any) => void;
  #rejectValuesFn?: (e: unknown) => void;
  readonly #valuesDone: Promise<TValues>;

  #valuesLog?: EventLog<Record<string, unknown>>;
  #messagesIterable?: AsyncIterable<ChatModelStream>;

  /**
   * @param path - Namespace path for this stream (empty array for root).
   * @param mux - The {@link StreamMux} driving this run.
   * @param discoveryStart - Cursor offset into the mux discovery log.
   * @param eventStart - Cursor offset into the mux event log.
   * @param extensions - Pre-initialized transformer projections.
   * @param abortController - Controller for programmatic cancellation.
   */
  constructor(
    path: Namespace,
    mux: StreamMux,
    discoveryStart = 0,
    eventStart = 0,
    extensions?: TExtensions,
    abortController?: AbortController
  ) {
    this.path = path;
    this._mux = mux;
    this.#discoveryStart = discoveryStart;
    this.#eventStart = eventStart;
    this.extensions = extensions ?? ({} as TExtensions);
    this.#abortController = abortController ?? new AbortController();
    this.#valuesDone = new Promise<TValues>((resolve, reject) => {
      this.#resolveValuesFn = resolve;
      this.#rejectValuesFn = reject;
    });
  }

  /**
   * Async iterator over all {@link ProtocolEvent}s at or below this
   * stream's namespace, starting from the configured event offset.
   *
   * @returns An async iterator yielding protocol events in arrival order.
   */
  [Symbol.asyncIterator](): AsyncIterator<ProtocolEvent> {
    return this._mux.subscribeEvents(this.path, this.#eventStart);
  }

  /**
   * Async iterable of child {@link SubgraphRunStream} instances discovered
   * during the run. Each yielded stream represents a direct child namespace.
   *
   * @returns An async iterable of subgraph run streams.
   */
  get subgraphs(): AsyncIterable<SubgraphRunStream> {
    const iter = this._mux.subscribeSubgraphs(this.path, this.#discoveryStart);
    return { [Symbol.asyncIterator]: () => iter };
  }

  /**
   * Dual-interface accessor for graph state snapshots.
   *
   * As an {@link AsyncIterable}, yields each intermediate state snapshot
   * as it arrives. As a {@link PromiseLike}, resolves with the final
   * state value when the run completes.
   *
   * @returns A combined async iterable and promise-like for state values.
   */
  get values(): AsyncIterable<TValues> & PromiseLike<TValues> {
    const log = this.#valuesLog;
    const done = this.#valuesDone;
    const mux = this._mux;
    const eventStart = this.#eventStart;
    const path = this.path;

    const iterable: AsyncIterable<TValues> = log
      ? (log.toAsyncIterable() as AsyncIterable<TValues>)
      : {
          [Symbol.asyncIterator]: () => {
            const base = mux.subscribeEvents(path, eventStart);
            return {
              async next(): Promise<IteratorResult<TValues>> {
                // eslint-disable-next-line no-constant-condition
                while (true) {
                  const result = await base.next();
                  if (result.done) {
                    return {
                      value: undefined as unknown as TValues,
                      done: true,
                    };
                  }
                  if (
                    result.value.method === "values" &&
                    result.value.params.namespace.length === path.length
                  ) {
                    return {
                      value: result.value.params.data as TValues,
                      done: false,
                    };
                  }
                }
              },
            };
          },
        };

    return {
      [Symbol.asyncIterator]: () => iterable[Symbol.asyncIterator](),
      then: done.then.bind(done),
    };
  }

  /**
   * All AI message lifecycles observed at this namespace level, in order.
   * Each yielded {@link ChatModelStream} represents one message-start →
   * message-finish lifecycle with streaming `.text`, `.reasoning`, and
   * `.usage` projections.
   *
   * @returns An async iterable of chat model streams.
   */
  get messages(): AsyncIterable<ChatModelStream> {
    if (this.#messagesIterable) return this.#messagesIterable;
    // Lazily create a messages transformer scoped to this stream's path.
    // This handles SubgraphRunStream instances that are created
    // dynamically by StreamMux and don't have a transformer pre-wired.
    const transformer = createMessagesReducer(this.path);
    this._mux.addTransformer(transformer);
    const projection = transformer.init();
    this.#messagesIterable = projection.messages;
    return this.#messagesIterable;
  }

  /**
   * Messages produced by a specific graph node. Use when the run has
   * multiple model-calling nodes and you only want messages from one.
   *
   * @param node - The graph node name to filter messages by.
   * @returns An async iterable of chat model streams from the given node.
   */
  messagesFrom(node: string): AsyncIterable<ChatModelStream> {
    const transformer = createMessagesReducer(this.path, node);
    this._mux.addTransformer(transformer);
    const projection = transformer.init();
    return projection.messages;
  }

  /**
   * Promise that resolves with the final graph state when the run completes,
   * or rejects if the run fails.
   *
   * @returns A promise resolving to the final state values.
   */
  get output(): Promise<TValues> {
    return this.#valuesDone;
  }

  /**
   * Whether the run ended due to a human-in-the-loop interrupt.
   *
   * @returns `true` if the run was interrupted.
   */
  get interrupted(): boolean {
    return this._mux.interrupted;
  }

  /**
   * Interrupt payloads collected during the run, if any.
   *
   * @returns A readonly array of interrupt payloads.
   */
  get interrupts(): readonly InterruptPayload[] {
    return this._mux.interrupts;
  }

  /**
   * Programmatically abort this run. Equivalent to calling
   * `signal.abort(reason)`.
   *
   * @param reason - Optional abort reason passed to the signal.
   */
  abort(reason?: unknown): void {
    this.#abortController.abort(reason);
  }

  /**
   * The {@link AbortSignal} wired into this run for cancellation support.
   *
   * @returns The abort signal for this stream.
   */
  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  /**
   * Resolve the output/values promise with the final state snapshot.
   * Called by {@link StreamMux.close}.
   *
   * @param values - The final state values, or `undefined` if none.
   * @internal
   */
  _resolveValues(values: TValues | undefined): void {
    this.#resolveValuesFn?.(values as TValues);
    this.#resolveValuesFn = undefined;
  }

  /**
   * Reject the output/values promise with a run error.
   * Called by {@link StreamMux.fail}.
   *
   * @param err - The error that caused the run to fail.
   * @internal
   */
  _rejectValues(err: unknown): void {
    this.#rejectValuesFn?.(err);
    this.#rejectValuesFn = undefined;
  }

  /**
   * Attach the transformer-populated event log backing the `.values` iterable.
   * Called during stream setup in {@link createGraphRunStream}.
   *
   * @param log - The event log from the values transformer projection.
   * @internal
   */
  _setValuesLog(log: EventLog<Record<string, unknown>>): void {
    this.#valuesLog = log;
  }

  /**
   * Attach the transformer-populated async iterable backing the `.messages`
   * accessor. Called during stream setup in {@link createGraphRunStream}.
   *
   * @param iterable - The async iterable from the messages transformer projection.
   * @internal
   */
  _setMessagesIterable(iterable: AsyncIterable<ChatModelStream>): void {
    this.#messagesIterable = iterable;
  }
}

/**
 * A run stream for a child subgraph within a parent graph execution.
 *
 * Extends {@link GraphRunStream} with a parsed {@link name} and
 * {@link index} extracted from the last segment of the namespace path.
 * The segment is expected to follow the `"name:index"` convention;
 * when no numeric suffix is present, {@link index} defaults to `0`.
 *
 * @typeParam TValues - Shape of the subgraph's state values.
 * @typeParam TExtensions - Shape of additional transformer projections.
 */
export class SubgraphRunStream<
  TValues = Record<string, unknown>,
  TExtensions extends Record<string, unknown> = Record<string, unknown>,
> extends GraphRunStream<TValues, TExtensions> {
  /**
   * The node name extracted from the last segment of the namespace path
   * (everything before the final colon, or the full segment if no colon).
   */
  readonly name: string;

  /**
   * The invocation index parsed from the `"name:N"` suffix of the last
   * namespace segment. Defaults to `0` when no numeric suffix is present.
   */
  readonly index: number;

  /**
   * @param path - Namespace path for this subgraph stream.
   * @param mux - The {@link StreamMux} driving this run.
   * @param discoveryStart - Cursor offset into the mux discovery log.
   * @param eventStart - Cursor offset into the mux event log.
   * @param extensions - Pre-initialized transformer projections.
   * @param abortController - Controller for programmatic cancellation.
   */
  constructor(
    path: Namespace,
    mux: StreamMux,
    discoveryStart = 0,
    eventStart = 0,
    extensions?: TExtensions,
    abortController?: AbortController
  ) {
    super(path, mux, discoveryStart, eventStart, extensions, abortController);
    const lastSegment = path[path.length - 1] ?? "";
    const colonIdx = lastSegment.lastIndexOf(":");
    if (colonIdx >= 0) {
      this.name = lastSegment.slice(0, colonIdx);
      const suffix = lastSegment.slice(colonIdx + 1);
      this.index = /^\d+$/.test(suffix) ? Number(suffix) : 0;
    } else {
      this.name = lastSegment;
      this.index = 0;
    }
  }
}

// Register constructors with StreamMux to break the circular dependency.
setRunStreamClasses(GraphRunStream, SubgraphRunStream);

/**
 * Creates a {@link GraphRunStream} with built-in transformers and kicks off the
 * background pump that feeds raw stream chunks through the transformer pipeline.
 *
 * Built-in transformers (values and messages) are registered first, followed by
 * any user-supplied transformer factories. The root stream is registered with the
 * mux and the pump is started in the background.
 *
 * @typeParam TValues - Shape of the graph's state values.
 * @param source - Raw async iterable from `graph.stream(…, { subgraphs: true })`.
 * @param transformers - User-supplied transformer factories.
 * @param abortController - Optional controller for cancellation.
 * @returns A {@link GraphRunStream} for the root namespace.
 */
export function createGraphRunStream<
  TValues = Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TTransformers extends ReadonlyArray<() => StreamTransformer<any>> = [],
>(
  source: AsyncIterable<StreamChunk>,
  transformers: TTransformers = [] as unknown as TTransformers,
  abortController?: AbortController
): GraphRunStream<TValues, InferExtensions<TTransformers>> {
  const mux = new StreamMux();

  const valuesTransformer = createValuesReducer([]);
  const messagesTransformer = createMessagesReducer([]);
  mux.addTransformer(valuesTransformer);
  mux.addTransformer(messagesTransformer);

  const extensions: Record<string, unknown> = {};
  for (const factory of transformers) {
    const transformer = factory();
    mux.addTransformer(transformer);
    Object.assign(extensions, transformer.init());
  }

  const root = new GraphRunStream<TValues, InferExtensions<TTransformers>>(
    [],
    mux,
    0,
    0,
    extensions as InferExtensions<TTransformers>,
    abortController
  );

  // Wire transformer projections into the root stream.
  const valuesProjection = valuesTransformer.init();
  root._setValuesLog(valuesProjection._valuesLog);

  const messagesProjection = messagesTransformer.init();
  root._setMessagesIterable(messagesProjection.messages);

  mux.register([], root);

  // Start background pump.
  pump(source, mux).catch((err) => {
    void err;
  });

  return root;
}
