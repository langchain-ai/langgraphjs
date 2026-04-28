/**
 * Core type definitions for the v2 streaming interface.
 *
 * Channel event data types (`MessagesEventData`, `ToolsEventData`,
 * `UpdatesEventData`, `UsageInfo`, `Checkpoint`, `CheckpointSource`) are
 * re-exported from `@langchain/protocol` — the generated TypeScript
 * bindings for the canonical CDDL schema.  Stream-specific types
 * (`StreamTransformer`, `ChatModelStream`, `ToolCallStream`,
 * `InterruptPayload`) are defined here.
 */

import type { ChatModelStream as CoreChatModelStream } from "@langchain/core/language_models/stream";
import type { ChatModelStreamEvent as CoreChatModelStreamEvent } from "@langchain/core/language_models/event";
import type { StreamMode } from "../pregel/types.js";

/**
 * Re-exports from `@langchain/protocol`.
 *
 * These are the canonical wire-format types generated from `protocol.cddl`.
 * They are re-exported with local aliases so that consumers of this module
 * do not need a direct dependency on `@langchain/protocol`.
 */
export type {
  MessagesData as MessagesEventData,
  ToolsData as ToolsEventData,
  UpdatesData as UpdatesEventData,
  UsageInfo,
  MessageStartData,
  ContentBlockStartData,
  ContentBlockDeltaData,
  ContentBlockFinishData,
  MessageFinishData,
  MessageErrorData,
  ToolStartedData,
  ToolOutputDeltaData,
  ToolFinishedData,
  ToolErrorData,
  Checkpoint,
  CheckpointSource,
  AgentStatus,
  LifecycleData,
  LifecycleCause,
} from "@langchain/protocol";

/**
 * Hierarchical path identifying a position in the agent tree.
 *
 * Each element is one segment; longer arrays mean deeper nesting (e.g.
 * subgraph or multi-agent scopes).
 */
export type Namespace = string[];

/**
 * Channels that can appear on a protocol event.  Beyond the raw
 * {@link StreamMode} channels emitted by the Pregel stream, the v2
 * protocol layer synthesizes additional channels (e.g. `lifecycle`,
 * `input`) via built-in {@link StreamTransformer}s and exposes
 * user-defined channels created with {@link StreamChannel}.
 */
export type ProtocolMethod = StreamMode | "lifecycle" | "input" | (string & {});

/**
 * Single envelope for a streaming protocol emission: sequence, channel
 * (`method`), and payload (`params`).
 */
export interface ProtocolEvent {
  /** Discriminator; always `"event"` for this shape. */
  readonly type: "event";

  /** Monotonic sequence number for ordering and deduplication within a run. */
  readonly seq: number;

  /**
   * Logical stream channel.  Built-in channels match {@link StreamMode}
   * (e.g. `messages`, `updates`); transformer-synthesized channels
   * include `lifecycle` and `input`; user-defined channels carry their
   * {@link StreamChannel.channelName}.
   */
  readonly method: ProtocolMethod;

  /** Channel-specific payload and routing metadata. */
  readonly params: {
    /** Namespace of the node or scope that emitted this event. */
    readonly namespace: Namespace;

    /** Wall-clock or logical timestamp for the emission (milliseconds). */
    readonly timestamp: number;

    /**
     * Graph node id when the engine can attribute the event to a single node;
     * omitted for run-level or ambiguous emissions.
     */
    readonly node?: string;

    /** Opaque channel payload; shape depends on `method`. */
    readonly data: unknown;
  };
}

/**
 * Infers the merged extensions type from a tuple of transformer factory functions.
 *
 * Given `[() => StreamTransformer<{ a: number }>, () => StreamTransformer<{ b: string }>]`,
 * produces `{ a: number } & { b: string }`.
 */
export type InferExtensions<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends ReadonlyArray<() => StreamTransformer<any>>,
> = T extends readonly []
  ? Record<string, never>
  : T extends readonly [
        () => StreamTransformer<infer P>,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...infer Rest extends ReadonlyArray<() => StreamTransformer<any>>,
      ]
    ? P & InferExtensions<Rest>
    : Record<string, unknown>;

/**
 * Observes {@link ProtocolEvent}s during a graph run and builds typed derived
 * projections (secondary event logs, promises, etc.).
 *
 * Data is surfaced to consumers through **projections** returned from
 * `init()`.  Projections are merged into `GraphRunStream.extensions` for
 * in-process consumers.  Use {@link StreamChannel.local} for local streaming
 * values, {@link StreamChannel.remote} for values that should also be visible
 * to remote clients, or `Promise<T>` for final values.
 *
 * To make projection data available to **remote** clients (SDK consumers
 * over WebSocket / SSE), create a named channel with
 * `StreamChannel.remote(name)`.  The {@link StreamMux} detects named
 * `StreamChannel` instances in the `init()` return and auto-forwards every
 * `push()` as a {@link ProtocolEvent} on the channel's named method.  Remote
 * clients subscribe via `session.subscribe("custom:<name>")`.
 *
 * `finalize` and `fail` are optional.  When a transformer uses
 * `StreamChannel`, the mux auto-closes/fails the channels on run
 * completion — no manual lifecycle management needed.  Implement
 * `finalize`/`fail` only for non-channel teardown (e.g. resolving a
 * `Promise`).
 *
 * @typeParam TProjection - Shape returned by {@link init}, merged into
 *   `GraphRunStream.extensions`.
 */
export interface StreamTransformer<TProjection = unknown> {
  /**
   * Called once before the run starts.
   *
   * @returns Initial projection merged into `GraphRunStream.extensions`.
   *   Any named {@link StreamChannel} instances in the return value are
   *   automatically wired to the protocol event stream by the mux. Unnamed
   *   channels stay in-process-only.
   */
  init(): TProjection;

  /**
   * Optional hook invoked by {@link StreamMux.addTransformer} immediately
   * after the transformer is attached to the mux. Receives a limited
   * handle that exposes only {@link StreamEmitter.push} — enough for
   * the transformer to emit synthesized {@link ProtocolEvent}s on any
   * namespace it chooses (e.g. a deepagents `SubagentTransformer`
   * fabricating `lifecycle`/`messages`/`values` events under a
   * `["tools:<tool_call_id>"]` namespace when a `task` tool starts).
   *
   * Transformers that do not synthesize events can omit this hook.
   *
   * The {@link StreamEmitter} handle is only safe to call *from within*
   * {@link StreamTransformer.process}. Emitting from an unrelated async
   * context (e.g. after `process` has returned, from a `setTimeout`,
   * etc.) races with the mux's close/fail cycle and may land events in
   * an already-closed log.
   */
  onRegister?(emitter: StreamEmitter): void;

  /**
   * Called for each {@link ProtocolEvent} before it is appended to the main log.
   *
   * @param event - Next protocol envelope for this run.
   * @returns `false` to drop the original event from the main log (use
   *   sparingly; prefer keeping events visible and adding derived data
   *   alongside).
   */
  process(event: ProtocolEvent): boolean;

  /**
   * Called once when the underlying Pregel run completes without throwing.
   * Optional — only needed for non-channel teardown (e.g. resolving promises).
   *
   * May return a `PromiseLike<void>` to defer the main event log close
   * until the async work (e.g. emitting terminal lifecycle events) has
   * completed.  The mux awaits all returned promises before closing its
   * event log.
   */
  finalize?(): void | PromiseLike<void>;

  /**
   * Called once when the run fails; `err` is the rejection or error value.
   * Optional — only needed for non-channel teardown (e.g. rejecting promises).
   *
   * @param err - Failure reason from the engine or user code.
   */
  fail?(err: unknown): void;
}

/**
 * Narrow capability handle passed to
 * {@link StreamTransformer.onRegister}. Exposes only the minimal mux
 * surface required for synthetic event emission — intentionally does
 * not expose close/fail/register/etc. to keep the transformer contract
 * small and tamper-resistant.
 */
export interface StreamEmitter {
  /**
   * Injects a new {@link ProtocolEvent} into the mux pipeline. The
   * event is routed through every registered transformer (including
   * the emitting transformer — implementers must guard against
   * re-entrant self-processing) and, if not suppressed, appended to
   * the main event log.
   *
   * @param ns - Target namespace for the synthetic event.
   * @param event - The event envelope to inject. ``event.seq`` is
   *   overwritten by the mux; callers can pass any placeholder.
   */
  push(ns: Namespace, event: ProtocolEvent): void;
}

export type ChatModelStream = Omit<
  CoreChatModelStream,
  typeof Symbol.asyncIterator
> & {
  /** Namespace of the graph node that produced this stream. */
  readonly namespace: Namespace;

  /** Graph node id for this stream, if the runtime attributed it. */
  readonly node: string | undefined;

  /**
   * Low-level async iteration over message lifecycle events.
   *
   * @returns Iterator yielding Core-compatible chat model stream events.
   */
  [Symbol.asyncIterator](): AsyncIterator<CoreChatModelStreamEvent>;
};

/**
 * Public view yielded by `run.messages`.
 *
 * `ChatModelStream` is PromiseLike to mirror Core, but TypeScript applies
 * `Awaited<T>` to values produced by `for await`. Exposing a non-thenable view
 * keeps loop variables typed as the streaming handle instead of `AIMessage`.
 */
export type ChatModelStreamHandle = Omit<ChatModelStream, "then">;

/**
 * High-level outcome of a single tool call for UI or aggregators.
 */
export type ToolCallStatus =
  /** Invocation in flight or output still streaming. */
  | "running"
  /** Completed without error. */
  | "finished"
  /** Failed or aborted; see {@link ToolCallStream.error}. */
  | "error";

/**
 * Stable handle for one tool call: name, arguments, and async results.
 *
 * Emitted when `content-block-finish` delivers a finalized `tool_call` block.
 *
 * @typeParam TName - Registered tool name.
 * @typeParam TInput - Parsed or raw input type for the call.
 * @typeParam TOutput - Successful result type after the tool returns.
 */
export interface ToolCallStream<
  TName extends string = string,
  TInput = unknown,
  TOutput = unknown,
> {
  /** Tool identifier as registered on the graph or model schema. */
  readonly name: TName;

  /** Correlates with protocol `toolCallId` when the runtime provides one. */
  readonly callId: string;

  /** Arguments passed to the tool (finalized when the call is observable). */
  readonly input: TInput;

  /**
   * Resolves to the tool return value on success.
   *
   * @remarks
   * Rejection or hang semantics depend on the runner; pairing with
   * {@link ToolCallStream.status} and {@link ToolCallStream.error} is recommended.
   */
  readonly output: Promise<TOutput>;

  /**
   * Resolves to {@link ToolCallStatus} when the call leaves the running state.
   */
  readonly status: Promise<ToolCallStatus>;

  /**
   * Resolves to an error message string if {@link ToolCallStream.status} is
   * `"error"`, otherwise `undefined`.
   */
  readonly error: Promise<string | undefined>;
}

/**
 * Marker interface for transformers provided by internal LangChain products
 * (e.g. ReactAgent's ToolCallTransformer, DeepAgent's SubagentTransformer).
 *
 * Native transformers differ from user-defined extension transformers in
 * where their projection lands on the run stream:
 *
 *   - **Native** — projections become direct getters on a
 *     `GraphRunStream` subclass (e.g. `run.toolCalls`, `run.subagents`).
 *     They emit events on protocol-defined channels (`tools`, `lifecycle`,
 *     `tasks`, etc.).
 *
 *   - **Extension** (user-defined) — projections are merged into
 *     `run.extensions`.  Events emitted via `emit()` use an
 *     application-chosen method name (e.g. `emit("a2a", data)`) and are
 *     accessible to remote clients via `session.subscribe("custom:<name>")`.
 *
 * The `__native` brand is used by downstream stream factory functions
 * to distinguish native transformers from extension transformers at
 * registration time.  See `docs/native-stream-transformers.md` for the
 * full pattern.
 */
export interface NativeStreamTransformer<
  TProjection = unknown,
> extends StreamTransformer<TProjection> {
  readonly __native: true;
}

/**
 * Type guard that tests whether a transformer is a {@link NativeStreamTransformer}.
 */
export function isNativeTransformer(
  t: StreamTransformer<unknown>
): t is NativeStreamTransformer {
  return "__native" in t && (t as NativeStreamTransformer).__native === true;
}

/**
 * Human-in-the-loop interrupt: stable id plus opaque payload for resume UIs.
 */
export interface InterruptPayload<TPayload = unknown> {
  /** Idempotent key for this interrupt instance within the run. */
  interruptId: string;

  /** Arbitrary data supplied by the graph (e.g. questions, draft state). */
  payload: TPayload;
}
