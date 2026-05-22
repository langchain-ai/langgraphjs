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
 *
 * Internal LangChain products (ReactAgent, DeepAgent) can subclass
 * GraphRunStream to add native projections (e.g. `run.toolCalls`,
 * `run.subagents`).  See docs/native-stream-transformers.md for the
 * pattern.
 */

import type { StreamChunk } from "../pregel/stream.js";
import {
  createLifecycleTransformer,
  createMessagesTransformer,
  createSubgraphDiscoveryTransformer,
  createValuesTransformer,
  filterLifecycleEntries,
  filterSubgraphHandles,
  type LifecycleEntry,
} from "./transformers/index.js";
import { StreamMux, pump, RESOLVE_VALUES, REJECT_VALUES } from "./mux.js";
import {
  isNativeTransformer,
  type ChatModelStreamHandle,
  type InferExtensions,
  type InterruptPayload,
  type Namespace,
  type ProtocolEvent,
  type StreamTransformer,
} from "./types.js";
import type { StreamChannel } from "./stream-channel.js";

/**
 * Symbol key for attaching the values log to a stream handle.
 * Using a symbol keeps this off the public autocomplete surface.
 */
export const SET_VALUES_LOG: unique symbol = Symbol("setValuesLog");

/**
 * Symbol key for attaching the messages iterable to a stream handle.
 * Using a symbol keeps this off the public autocomplete surface.
 */
export const SET_MESSAGES_ITERABLE: unique symbol = Symbol(
  "setMessagesIterable"
);

/**
 * Symbol key for attaching the lifecycle iterable to a stream handle.
 * Using a symbol keeps this off the public autocomplete surface.
 */
export const SET_LIFECYCLE_ITERABLE: unique symbol = Symbol(
  "setLifecycleIterable"
);

/**
 * Symbol key for attaching the subgraphs iterable to a stream handle.
 * Using a symbol keeps this off the public autocomplete surface.
 */
export const SET_SUBGRAPHS_ITERABLE: unique symbol = Symbol(
  "setSubgraphsIterable"
);

/**
 * Shared empty async iterable, returned from getters that haven't
 * been wired by {@link createGraphRunStream}.  Avoids allocating a
 * fresh empty iterable on every access.
 */
const EMPTY_ASYNC_ITERABLE: AsyncIterable<never> = {
  [Symbol.asyncIterator](): AsyncIterator<never> {
    return {
      next: () =>
        Promise.resolve({
          value: undefined as never,
          done: true,
        }),
    };
  },
};

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

  #valuesLog?: StreamChannel<Record<string, unknown>>;
  #messagesIterable?: AsyncIterable<ChatModelStreamHandle>;
  #lifecycleIterable?: AsyncIterable<LifecycleEntry>;
  #subgraphsIterable?: AsyncIterable<SubgraphRunStream>;

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
    this.#valuesDone.catch(() => {
      // Keep run failures observable to explicit `await run.output` callers
      // without reporting unhandled rejections when consumers only iterate
      // protocol events.
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
   * Backed by the shared `_discoveries` log on the mux, populated by
   * {@link createSubgraphDiscoveryTransformer}.  For streams created
   * through {@link createGraphRunStream} the iterable is pre-wired
   * (via {@link SET_SUBGRAPHS_ITERABLE}) so iteration is cheap.
   * Streams constructed directly (e.g. in unit tests) fall back to
   * filtering `_mux._discoveries` on demand, preserving the original
   * behavior without requiring explicit wiring.
   *
   * @returns An async iterable of subgraph run streams.
   */
  get subgraphs(): AsyncIterable<SubgraphRunStream> {
    if (this.#subgraphsIterable) return this.#subgraphsIterable;
    return filterSubgraphHandles<SubgraphRunStream>(
      this._mux._discoveries,
      this.path,
      this.#discoveryStart
    );
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
  get messages(): AsyncIterable<ChatModelStreamHandle> {
    if (this.#messagesIterable) return this.#messagesIterable;
    // Lazily create a messages transformer scoped to this stream's path.
    // This handles SubgraphRunStream instances that are created
    // dynamically by StreamMux and don't have a transformer pre-wired.
    // Uses addTransformer (which replays buffered events) so that
    // messages emitted before the getter is first accessed are not lost.
    const transformer = createMessagesTransformer(this.path);
    const projection = transformer.init();
    this._mux.addTransformer(transformer);
    this.#messagesIterable = projection.messages;
    return this.#messagesIterable;
  }

  /**
   * Sequence of {@link LifecycleEntry} records tracking the
   * `lifecycle` channel: when the run starts, when each subgraph
   * enters/exits, and the terminal status of the run as a whole.
   *
   * Backed by the built-in {@link createLifecycleTransformer}; the
   * root stream's iterable is wired during
   * {@link createGraphRunStream} setup, and each
   * {@link SubgraphRunStream} is wired in the subgraph discovery
   * factory with a subtree-scoped view (via
   * {@link filterLifecycleEntries}).  Streams constructed outside
   * `createGraphRunStream` and not wired will yield nothing.
   *
   * @returns An async iterable of lifecycle entries in emission order.
   */
  get lifecycle(): AsyncIterable<LifecycleEntry> {
    return this.#lifecycleIterable ?? EMPTY_ASYNC_ITERABLE;
  }

  /**
   * Messages produced by a specific graph node. Use when the run has
   * multiple model-calling nodes and you only want messages from one.
   *
   * @param node - The graph node name to filter messages by.
   * @returns An async iterable of chat model streams from the given node.
   */
  messagesFrom(node: string): AsyncIterable<ChatModelStreamHandle> {
    const transformer = createMessagesTransformer(this.path, node);
    const projection = transformer.init();
    this._mux.addTransformer(transformer);
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
  [RESOLVE_VALUES](values: TValues | undefined): void {
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
  [REJECT_VALUES](err: unknown): void {
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
  [SET_VALUES_LOG](log: StreamChannel<Record<string, unknown>>): void {
    this.#valuesLog = log;
  }

  /**
   * Attach the transformer-populated async iterable backing the `.messages`
   * accessor. Called during stream setup in {@link createGraphRunStream}.
   *
   * @param iterable - The async iterable from the messages transformer projection.
   * @internal
   */
  [SET_MESSAGES_ITERABLE](
    iterable: AsyncIterable<ChatModelStreamHandle>
  ): void {
    this.#messagesIterable = iterable;
  }

  /**
   * Attach the transformer-populated async iterable backing the
   * `.lifecycle` accessor. Called during stream setup in
   * {@link createGraphRunStream}.
   *
   * @param iterable - The async iterable from the lifecycle transformer projection.
   * @internal
   */
  [SET_LIFECYCLE_ITERABLE](iterable: AsyncIterable<LifecycleEntry>): void {
    this.#lifecycleIterable = iterable;
  }

  /**
   * Attach the transformer-populated async iterable backing the
   * `.subgraphs` accessor. Called during root stream setup in
   * {@link createGraphRunStream} and during child stream
   * construction in the discovery transformer factory.
   *
   * @param iterable - The async iterable of direct-child stream handles.
   * @internal
   */
  [SET_SUBGRAPHS_ITERABLE](iterable: AsyncIterable<SubgraphRunStream>): void {
    this.#subgraphsIterable = iterable;
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

/**
 * Options accepted by {@link createGraphRunStream}.
 */
export interface CreateGraphRunStreamOptions {
  /**
   * Optional abort controller shared with the outer run; if omitted, a
   * fresh controller is allocated for the returned stream.
   */
  abortController?: AbortController;
}

/**
 * Creates a {@link GraphRunStream} with built-in transformers and kicks off the
 * background pump that feeds raw stream chunks through the transformer pipeline.
 *
 * Built-in transformers are registered in this order:
 *   1. subgraph discovery — materializes SubgraphRunStream handles
 *      for each newly observed top-level namespace and announces them
 *      on the mux `_discoveries` log.
 *   2. lifecycle — synthesizes `lifecycle` channel events.
 *   3. values — powers `run.values` / `run.output`.
 *   4. messages — powers `run.messages` / `.messagesFrom`.
 *
 * Subgraph discovery is registered first so that downstream
 * transformers (notably lifecycle) observe child namespaces with
 * their stream handles already in place.  User-supplied transformer
 * factories are registered afterwards.
 *
 * @typeParam TValues - Shape of the graph's state values.
 * @param source - Raw async iterable from `graph.stream(…, { subgraphs: true })`.
 * @param transformers - User-supplied transformer factories.
 * @param optionsOrAbortController - Either a full
 *   {@link CreateGraphRunStreamOptions} object or (for backward
 *   compatibility) a bare `AbortController`.
 * @returns A {@link GraphRunStream} for the root namespace.
 */
export function createGraphRunStream<
  TValues = Record<string, unknown>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TTransformers extends ReadonlyArray<() => StreamTransformer<any>> = [],
>(
  source: AsyncIterable<StreamChunk>,
  transformers: TTransformers = [] as unknown as TTransformers,
  optionsOrAbortController?: CreateGraphRunStreamOptions | AbortController
): GraphRunStream<TValues, InferExtensions<TTransformers>> {
  const options: CreateGraphRunStreamOptions =
    // oxlint-disable-next-line no-instanceof/no-instanceof
    optionsOrAbortController instanceof AbortController
      ? { abortController: optionsOrAbortController }
      : (optionsOrAbortController ?? {});
  const { abortController } = options;

  const mux = new StreamMux();

  // Init lifecycle first so the subgraph discovery factory can close
  // over its log to wire each new child's `.lifecycle` view.
  const lifecycleTransformer = createLifecycleTransformer();
  const lifecycleProjection = lifecycleTransformer.init();
  const lifecycleLog = lifecycleProjection._lifecycleLog;

  const subgraphDiscoveryTransformer =
    createSubgraphDiscoveryTransformer<SubgraphRunStream>(mux, {
      createStream: (path, discoveryStart, eventStart) => {
        const sub = new SubgraphRunStream(
          path,
          mux,
          discoveryStart,
          eventStart
        );
        // Wire the child's `.subgraphs` to the shared discoveries log,
        // scoped to the child's path and its construction-time offset.
        sub[SET_SUBGRAPHS_ITERABLE](
          filterSubgraphHandles<SubgraphRunStream>(
            mux._discoveries,
            path,
            discoveryStart
          )
        );
        // Wire the child's `.lifecycle` to the shared lifecycle log,
        // filtered to its subtree.  Capture the current log size so
        // entries emitted before discovery (e.g. root's `started`)
        // aren't replayed to the child.  Entries emitted for this
        // discovery event itself land after the factory returns (the
        // subgraph transformer runs before the lifecycle transformer),
        // so the child still receives its own `started`.
        sub[SET_LIFECYCLE_ITERABLE](
          filterLifecycleEntries(lifecycleLog, path, lifecycleLog.size)
        );
        return sub;
      },
    });
  const subgraphsProjection = subgraphDiscoveryTransformer.init();

  // Registration order matters: subgraph discovery runs first so that
  // lifecycle and downstream transformers see child stream handles
  // already materialized.
  mux.addTransformer(subgraphDiscoveryTransformer);
  mux.addTransformer(lifecycleTransformer);

  const valuesTransformer = createValuesTransformer([]);
  const messagesTransformer = createMessagesTransformer([]);
  mux.addTransformer(valuesTransformer);
  mux.addTransformer(messagesTransformer);

  const extensions: Record<string, unknown> = {};
  const nativeProjections: Record<string, unknown>[] = [];
  for (const factory of transformers) {
    const transformer = factory();
    mux.addTransformer(transformer);
    const projection = transformer.init();
    if (isNativeTransformer(transformer)) {
      nativeProjections.push(projection);
    } else {
      Object.assign(extensions, projection);
    }
    // Only wire channels for extension transformers. Native transformers
    // produce non-serializable projections (Promises, AsyncIterables) that
    // must stay in-process — wiring them would inject garbage into the
    // protocol event stream.
    if (
      typeof projection === "object" &&
      projection !== null &&
      !isNativeTransformer(transformer)
    ) {
      mux.wireChannels(projection as Record<string, unknown>);
    }
  }

  const root = new GraphRunStream<TValues, InferExtensions<TTransformers>>(
    [],
    mux,
    0,
    0,
    extensions as InferExtensions<TTransformers>,
    abortController
  );

  /**
   * Assign native transformer projections to the root stream.
   */
  for (const proj of nativeProjections) {
    Object.assign(root, proj);
  }

  // Wire transformer projections into the root stream.
  const valuesProjection = valuesTransformer.init();
  root[SET_VALUES_LOG](valuesProjection._valuesLog);

  const messagesProjection = messagesTransformer.init();
  root[SET_MESSAGES_ITERABLE](messagesProjection.messages);
  root[SET_LIFECYCLE_ITERABLE](lifecycleProjection.lifecycle);
  root[SET_SUBGRAPHS_ITERABLE](subgraphsProjection.subgraphs);

  mux.register([], root);

  // Start background pump.
  pump(source, mux).catch((err) => {
    void err;
  });

  return root;
}
