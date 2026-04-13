/**
 * Core type definitions for the v2 streaming interface.
 *
 * Channel event data types (`MessagesEventData`, `ToolsEventData`,
 * `UpdatesEventData`, `UsageInfo`, `FinishReason`) are re-exported from
 * `@langchain/protocol` — the generated TypeScript bindings for the
 * canonical CDDL schema.  Stream-specific types (`StreamTransformer`,
 * `ChatModelStream`, `ToolCallStream`, `InterruptPayload`) are defined here.
 */

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
  FinishReason,
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
} from "@langchain/protocol";

/**
 * Hierarchical path identifying a position in the agent tree.
 *
 * Each element is one segment; longer arrays mean deeper nesting (e.g.
 * subgraph or multi-agent scopes).
 */
export type Namespace = string[];

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
   * Logical stream channel; matches {@link StreamMode} (e.g. messages, updates).
   */
  readonly method: StreamMode;

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
 * Observes protocol events and builds typed derived projections as secondary
 * event logs.
 *
 * @remarks
 * `TProjection` is merged into the run stream's public `.extensions` object.
 */
/**
 * Infers the merged extensions type from a tuple of transformer factory functions.
 *
 * Given `[() => StreamTransformer<{ a: number }>, () => StreamTransformer<{ b: string }>]`,
 * produces `{ a: number } & { b: string }`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type InferExtensions<
  T extends ReadonlyArray<() => StreamTransformer<any>>,
> = T extends readonly []
  ? Record<string, never>
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends readonly [
        () => StreamTransformer<infer P>,
        ...infer Rest extends ReadonlyArray<() => StreamTransformer<any>>,
      ]
    ? P & InferExtensions<Rest>
    : Record<string, unknown>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface StreamTransformer<TProjection = any> {
  /**
   * Called once before the run starts.
   *
   * @returns Initial projection merged into `GraphRunStream.extensions`.
   */
  init(): TProjection;

  /**
   * Called for each {@link ProtocolEvent} before it is appended to the main log.
   *
   * @param event - Next protocol envelope for this run.
   * @param emit - Callback to inject a new event into the main event stream
   *   with a specific channel method (e.g. `"tools"`, `"lifecycle"`,
   *   `"custom"`) and data payload.  Emitted events appear in the stream
   *   alongside raw events and flow through the protocol's channel-based
   *   subscription system to remote clients.
   * @returns `false` to drop the original event from the main log (use
   *   sparingly; prefer keeping events visible and adding derived data
   *   alongside).
   */
  process(
    event: ProtocolEvent,
    emit: (method: string, data: unknown) => void
  ): boolean;

  /**
   * Called once when the underlying Pregel run completes without throwing.
   *
   * @param emit - Same emit callback as in `process()`, allowing the
   *   transformer to inject terminal events (e.g. "completed" status) into
   *   the protocol stream before it closes.
   */
  finalize(emit?: (method: string, data: unknown) => void): void;

  /**
   * Called once when the run fails; `err` is the rejection or error value.
   *
   * @param err - Failure reason from the engine or user code.
   * @param emit - Same emit callback as in `process()`, allowing the
   *   transformer to inject terminal events (e.g. "failed" status) into the
   *   protocol stream before it closes.
   */
  fail(err: unknown, emit?: (method: string, data: unknown) => void): void;
}

import type { MessagesData as MessagesEventDataImport } from "@langchain/protocol";
import type { UsageInfo as UsageInfoImport } from "@langchain/protocol";

/**
 * Async view of one assistant message lifecycle
 * (`message-start` → content blocks → `message-finish`).
 *
 * Provides raw event iteration plus ergonomic accessors for text,
 * reasoning, and usage.
 */
export interface ChatModelStream extends AsyncIterable<MessagesEventDataImport> {
  /**
   * Text content for this message.
   *
   * @remarks
   * Use as an `AsyncIterable<string>` to consume streaming deltas; `await` the
   * same value (or use `.then`) to obtain the full concatenated string after
   * the message completes.
   */
  get text(): AsyncIterable<string> & PromiseLike<string>;

  /**
   * Reasoning / thinking trace for this message, when the model exposes it.
   *
   * @remarks
   * Same dual pattern as {@link ChatModelStream.text}: iterate for deltas,
   * await for the full reasoning string.
   */
  get reasoning(): AsyncIterable<string> & PromiseLike<string>;

  /**
   * Token usage after `message-finish`, when present.
   *
   * @remarks
   * Promise-like only; resolves when usage is known or `undefined` if omitted.
   */
  get usage(): PromiseLike<UsageInfoImport | undefined>;

  /** Namespace of the graph node that produced this stream. */
  readonly namespace: Namespace;

  /** Graph node id for this stream, if the runtime attributed it. */
  readonly node: string | undefined;

  /**
   * Low-level async iteration over message lifecycle events.
   *
   * @returns Iterator yielding events in order.
   */
  [Symbol.asyncIterator](): AsyncIterator<MessagesEventDataImport>;
}

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
 * Human-in-the-loop interrupt: stable id plus opaque payload for resume UIs.
 */
export interface InterruptPayload {
  /** Idempotent key for this interrupt instance within the run. */
  interruptId: string;

  /** Arbitrary data supplied by the graph (e.g. questions, draft state). */
  payload: unknown;
}
