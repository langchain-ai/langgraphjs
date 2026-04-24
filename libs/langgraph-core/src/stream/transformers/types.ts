import type { AgentStatus, LifecycleData } from "@langchain/protocol";

import type { EventLog } from "../event-log.js";
import type { ChatModelStream, Namespace } from "../types.js";

/**
 * The projection shape merged into a run stream by the messages transformer.
 * Exposes a `messages` async iterable that yields one {@link ChatModelStream}
 * per AI message lifecycle observed during the run.
 */
export interface MessagesTransformerProjection {
  messages: AsyncIterable<ChatModelStream>;
}

/**
 * The projection shape merged into a run stream by the values transformer.
 * Exposes the underlying {@link EventLog} so that `StreamMux` can resolve
 * the final output value on close.
 */
export interface ValuesTransformerProjection {
  _valuesLog: EventLog<Record<string, unknown>>;
}

/**
 * Single lifecycle entry surfaced by the in-process
 * `GraphRunStream.lifecycle` projection. Combines the CDDL
 * {@link LifecycleData} payload with the namespace it applies to so
 * consumers can filter or correlate without dipping into raw
 * `ProtocolEvent`s.
 */
export interface LifecycleEntry extends LifecycleData {
  /** Namespace the lifecycle event applies to. */
  readonly namespace: Namespace;
  /** Wall-clock timestamp (milliseconds) of the emission. */
  readonly timestamp: number;
}

/**
 * Configuration knobs for {@link createLifecycleTransformer}.
 */
export interface LifecycleTransformerOptions {
  /**
   * Human-readable name for the root graph. Used as `graph_name` for
   * the root lifecycle event.
   *
   * @defaultValue `"root"`
   */
  rootGraphName?: string;

  /**
   * Lifecycle status emitted for the root namespace when
   * {@link LifecycleTransformerOptions.emitRootOnRegister} is `true`.
   *
   * @defaultValue `"running"`
   */
  initialStatus?: AgentStatus;

  /**
   * When `true`, the transformer emits the root `lifecycle.started` (or
   * `.running`) event synchronously from `onRegister` and emits the
   * terminal root event from `finalize`/`fail`. Set to `false` when an
   * outer authority (e.g. `RunProtocolSession`) is responsible for
   * root lifecycle emission; in that case the transformer still tracks
   * root status internally for cascade purposes but does not write to
   * the wire.
   *
   * @defaultValue `true`
   */
  emitRootOnRegister?: boolean;

  /**
   * Resolves a human-readable graph name for a non-root namespace.
   * The default uses the last segment of the namespace, stripping any
   * `:suffix` (e.g. `["tools:abc"]` -> `"tools"`).
   */
  getGraphName?: (ns: Namespace) => string;

  /**
   * Optional async hook consulted by `finalize()` to override the
   * computed terminal status. Returning a status here wins over the
   * pending-interrupt heuristic. Useful for carriers (like the API
   * session) that have authoritative knowledge of thread state.
   */
  getTerminalStatusOverride?: () => Promise<AgentStatus | undefined>;

  /**
   * Converts an unknown failure value to a string for the
   * `lifecycle.failed` `error` field.
   *
   * @defaultValue a default implementation that handles `Error` and
   *   primitives.
   */
  serializeError?: (err: unknown) => string;
}

/**
 * Projection returned from the lifecycle transformer's `init()`.
 *
 * The `EventLog` is closed automatically when the transformer
 * finalizes or fails, matching the lifetime contract of
 * {@link EventLog}. `_lifecycleLog` is intentionally underscore-
 * prefixed to signal that it is consumed by the run stream wiring
 * (see `run-stream.ts`) and not meant for direct user access -
 * consumers should read `run.lifecycle` instead.
 *
 * The `lifecycle` iterable is the root-scoped projection (prefix
 * `[]`, starting at offset `0`) mirroring the pattern used by the
 * subgraph discovery transformer.  Root stream wiring consumes it
 * via `SET_LIFECYCLE_ITERABLE`; child streams are wired with their
 * own path-scoped iterable produced by `filterLifecycleEntries`.
 */
export interface LifecycleProjection {
  _lifecycleLog: EventLog<LifecycleEntry>;
  lifecycle: AsyncIterable<LifecycleEntry>;
}
