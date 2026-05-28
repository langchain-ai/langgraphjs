/**
 * StreamMux — central dispatcher with transformer pipeline.
 *
 * Routes raw stream chunks through registered StreamTransformers, then appends
 * the resulting ProtocolEvents to the main local channel.  Also tracks
 * namespace discovery for SubgraphRunStream creation.
 *
 * lifecycle:
 *   graph.streamEvents(input, { version: "v3" })
 *     ├─ StreamMux starts pumping from graph.stream(…, { subgraphs: true })
 *     ├─ For each ProtocolEvent:
 *     │   ├─ transformer_1.process(event)
 *     │   ├─ transformer_2.process(event)
 *     │   └─ event appended to _events (unless suppressed)
 *     └─ On close: transformer_n.finalize() called in registration order
 */

import type { StreamChunk } from "../pregel/stream.js";
import { INTERRUPT, isInterrupted, type Interrupt } from "../constants.js";
import { convertToProtocolEvent, STREAM_EVENTS_V3_MODES } from "./convert.js";
import { StreamChannel, isStreamChannel } from "./stream-channel.js";
import type {
  InterruptPayload,
  Namespace,
  ProtocolEvent,
  StreamEmitter,
  StreamTransformer,
} from "./types.js";

export { STREAM_EVENTS_V3_MODES };

/**
 * Structural `PromiseLike<T>` predicate — true for thenables including
 * native promises, user-constructed `{ then }` objects, and helper
 * wrappers. Used by {@link StreamMux.wireChannels} to detect final-value
 * projections distinctly from streaming `StreamChannel` values.
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value != null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Symbol key used by {@link StreamMux} to resolve the values promise on a
 * stream handle. Using a symbol keeps this off the public autocomplete surface.
 */
export const RESOLVE_VALUES: unique symbol = Symbol("resolveValues");

/**
 * Symbol key used by {@link StreamMux} to reject the values promise on a
 * stream handle. Using a symbol keeps this off the public autocomplete surface.
 */
export const REJECT_VALUES: unique symbol = Symbol("rejectValues");

/**
 * Minimal interface that {@link StreamMux} requires from stream handles
 * for lifecycle resolution. This avoids a direct dependency on
 * `GraphRunStream` / `SubgraphRunStream`.
 */
export interface StreamHandle {
  [RESOLVE_VALUES](values: unknown): void;
  [REJECT_VALUES](err: unknown): void;
}

/**
 * Factory function that creates a subgraph stream handle for a newly
 * discovered namespace.
 *
 * Historically consumed by {@link StreamMux} at construction time;
 * today factories are consumed by
 * `createSubgraphDiscoveryTransformer` (via its `createStream`
 * option).  This shape is retained for consumers that still thread a
 * mux reference through the factory — the narrower transformer
 * option omits `mux` because it captures the mux in a closure.
 */
export type SubgraphStreamFactory = (
  path: Namespace,
  mux: StreamMux,
  discoveryStart: number,
  eventStart: number
) => StreamHandle;

/**
 * A discovered subgraph namespace paired with its run stream handle.
 */
export type SubgraphDiscovery = {
  ns: Namespace;
  stream: StreamHandle;
};

/**
 * Central event dispatcher that routes {@link ProtocolEvent}s through a
 * pipeline of {@link StreamTransformer}s, manages namespace discovery for
 * subgraph streams, and exposes async iteration over filtered event
 * sequences.
 *
 * One `StreamMux` instance exists per top-level
 * `streamEvents(..., { version: "v3" })` invocation.
 */
export class StreamMux {
  /** @internal All protocol events in arrival order (after reducer pipeline). */
  readonly _events = StreamChannel.local<ProtocolEvent>();

  /** @internal New-namespace discovery notifications. */
  readonly _discoveries = StreamChannel.local<SubgraphDiscovery>();

  /** Monotonic counter for auto-forwarded channel events. */
  #nextEmitSeq = 0;

  /** Whether the mux has been closed or failed. */
  #closed = false;

  /** The error passed to {@link fail}, if any. */
  #error: unknown;

  /** Whether the run was interrupted. */
  #interrupted = false;

  /**
   * Namespace of the event currently being processed by
   * {@link push}.  Read by {@link StreamChannel} wiring callbacks so
   * auto-forwarded events inherit the triggering event's namespace.
   */
  #currentNamespace: Namespace = [];

  readonly #transformers: StreamTransformer<unknown>[] = [];
  readonly #channels: StreamChannel<unknown>[] = [];
  readonly #streamMap = new Map<string, StreamHandle>();
  readonly #latestValues = new Map<string, Record<string, unknown>>();
  readonly #interrupts: InterruptPayload[] = [];

  /**
   * Final-value projection keys tracked for remote surfacing. Populated
   * by {@link wireChannels} when a transformer's projection contains a
   * `PromiseLike` value. Each entry is flushed as a `custom:<name>`
   * protocol event during {@link close} so that remote clients can
   * observe final-value transformers via `thread.extensions.<name>`.
   */
  readonly #finalValues: Array<{ name: string; promise: Promise<unknown> }> =
    [];

  /**
   * Associates a pre-existing stream handle with a namespace so that
   * {@link close} can resolve its values promise later.
   *
   * @param path - The namespace path to register.
   * @param stream - The run stream handle for that namespace.
   */
  register(path: Namespace, stream: StreamHandle): void {
    this.#streamMap.set(nsKey(path), stream);
  }

  /**
   * Registers a transformer and replays all buffered events through it so
   * it catches up with events already processed by the mux.  When the event
   * log is empty (typical at construction time) the replay is a no-op.
   *
   * The transformer must already have been initialised (i.e. `init()` called
   * and any projection wired).  The sequence is:
   *
   *   1. Snapshot the current event log length.
   *   2. Append the transformer so future {@link push} calls reach it.
   *   3. Replay events `[0, snapshot)` through `process()`.
   *   4. If the mux is already closed, call `finalize()` (or `fail()`)
   *      immediately so the transformer's log/channel terminates cleanly.
   *
   * @param transformer - An already-initialised transformer to register.
   */
  addTransformer(transformer: StreamTransformer<unknown>): void {
    const snapshot = this._events.size;
    this.#transformers.push(transformer);

    // Hand the transformer a narrow emitter handle *before* replay so
    // synthetic-emission transformers (e.g. deepagents
    // `SubagentTransformer`) can inject events into the mux during
    // their own `process()` calls — including the initial replay
    // triggered just below.
    if (transformer.onRegister) {
      const emitter: StreamEmitter = {
        // Transformer-originated events use a placeholder `seq` of
        // `0`.  `push()` is the single authority for sequence numbers
        // and will re-stamp this event with the next monotonically
        // increasing value.
        push: (ns, event) => this.push(ns, event),
      };
      transformer.onRegister(emitter);
    }

    for (let i = 0; i < snapshot; i += 1) {
      transformer.process(this._events.get(i));
    }

    if (this.#closed) {
      if (this.#error !== undefined) {
        transformer.fail?.(this.#error);
      } else {
        transformer.finalize?.();
      }
    }
  }

  /**
   * Scans a transformer projection for streaming and final-value primitives.
   * Remote stream channels are wired to auto-forward to the protocol event
   * stream; local stream channels are tracked for lifecycle only.
   *
   * Two projection shapes are recognised:
   *
   *   - {@link StreamChannel} values — named channels forward each `push()`
   *     immediately as a protocol event on the channel's declared
   *     `channelName` method. Unnamed channels remain in-process-only.
   *
   *   - `PromiseLike<unknown>` values — tracked as final-value
   *     projections and flushed on {@link close} as a single
   *     `custom:<key>` event, where `<key>` is the projection key.
   *     This mirrors the in-process `await run.extensions.<key>`
   *     ergonomics on remote clients via
   *     `await thread.extensions.<key>`.
   *
   * Plain values that are neither are ignored — they remain in-process-only,
   * matching prior behaviour.
   *
   * @param projection - The object returned by `transformer.init()`.
   */
  wireChannels(projection: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(projection)) {
      if (isStreamChannel(value)) {
        this.#channels.push(value);
        if (typeof value.channelName !== "string") {
          continue;
        }
        value._wire((item: unknown) => {
          this._events.push({
            type: "event",
            seq: this.#nextEmitSeq++,
            method: value.channelName as ProtocolEvent["method"],
            params: {
              namespace: this.#currentNamespace,
              timestamp: Date.now(),
              data: item,
            },
          });
        });
        continue;
      }
      if (isPromiseLike(value)) {
        this.#finalValues.push({
          name: key,
          promise: Promise.resolve(value),
        });
      }
    }
  }

  /**
   * Distributes an event through the transformer pipeline, then appends it to
   * the main event log.
   *
   * Subgraph discovery (materializing a {@link StreamHandle} for each
   * newly observed top-level namespace) is handled by the
   * {@link createSubgraphDiscoveryTransformer} when installed, not here.
   *
   * @param ns - The namespace path that produced the event.
   * @param event - The protocol event to process and store.
   */
  push(ns: Namespace, event: ProtocolEvent): void {
    if (event.method === "values") {
      this.#latestValues.set(
        nsKey(ns),
        event.params.data as Record<string, unknown>
      );
    }

    // Save the outer namespace so re-entrant `push()` calls (e.g. from
    // `StreamTransformer.onRegister` emitters synthesizing events
    // inside a transformer's `process()`) can set their own namespace
    // without clobbering the outer scope's `StreamChannel` routing
    // when control returns to the outer transformer loop.
    const outerNamespace = this.#currentNamespace;
    this.#currentNamespace = ns;

    let keep = true;
    for (const transformer of this.#transformers) {
      if (!transformer.process(event)) {
        keep = false;
      }
    }

    this.#currentNamespace = outerNamespace;

    if (keep) {
      // The mux is the single authority for sequence numbers.  Callers
      // (the `pump`, transformer emitters, channel forwarders) pass a
      // placeholder `seq`; we re-stamp every event here so the log is
      // strictly monotonic across all origination paths.  Stamping
      // happens *after* `process()` so that any channel-forwarded
      // events pushed during processing get earlier sequence numbers
      // than the triggering event, matching their in-order appearance
      // in `_events`.
      this._events.push({ ...event, seq: this.#nextEmitSeq++ });
    }
  }

  /**
   * Gracefully ends the stream: resolves values promises on all known
   * streams, finalizes every transformer, auto-closes streaming
   * channels, flushes any final-value projections as `custom:<name>`
   * events, and closes both event logs.
   *
   * When final-value projections are present, `_events.close()` is
   * deferred until every tracked projection promise has settled so
   * remote consumers observe the flushed values before their event
   * stream ends. Callers do not need to await — `close()` returns
   * synchronously and any downstream consumer iterating
   * {@link _events} naturally waits for the final events.
   */
  close(): void {
    this.#closed = true;
    for (const [key, values] of this.#latestValues.entries()) {
      const ns = key ? key.split("\x00") : [];
      const stream = this.#streamMap.get(nsKey(ns));
      stream?.[RESOLVE_VALUES](values);
    }

    const finalizePromises: PromiseLike<void>[] = [];
    for (const transformer of this.#transformers) {
      const result = transformer.finalize?.();
      if (
        result != null &&
        typeof (result as PromiseLike<void>).then === "function"
      ) {
        finalizePromises.push(result as PromiseLike<void>);
      }
    }

    for (const channel of this.#channels) {
      channel._close();
    }

    const finalValues = this.#finalValues;
    if (finalValues.length === 0 && finalizePromises.length === 0) {
      this._events.close();
      this._discoveries.close();
    } else {
      void Promise.allSettled([
        ...finalizePromises,
        ...finalValues.map(async ({ name, promise }) => {
          try {
            const resolved = await promise;
            if (!this._events.done) {
              this._events.push({
                type: "event",
                seq: this.#nextEmitSeq++,
                method: "custom",
                params: {
                  namespace: [],
                  timestamp: Date.now(),
                  data: { name, payload: resolved },
                },
              });
            }
          } catch {
            // Rejected final-value projections are intentionally dropped
            // so a single failing extension can't poison the protocol
            // stream. The corresponding in-process Promise still
            // surfaces the rejection to its direct awaiters via the
            // transformer's own `fail()` hook.
          }
        }),
      ]).then(() => {
        this._events.close();
        this._discoveries.close();
      });
    }

    for (const stream of this.#streamMap.values()) {
      stream[RESOLVE_VALUES](undefined);
    }
  }

  /**
   * Propagates a failure to all transformers, channels, event logs, and
   * stream handles.
   *
   * @param err - The error that caused the run to fail.
   */
  fail(err: unknown): void {
    this.#closed = true;
    this.#error = err;
    for (const transformer of this.#transformers) {
      transformer.fail?.(err);
    }
    for (const channel of this.#channels) {
      channel._fail(err);
    }
    this._events.fail(err);
    this._discoveries.fail(err);
    for (const stream of this.#streamMap.values()) {
      stream[REJECT_VALUES](err);
    }
  }

  /**
   * Records that the run was interrupted, appending the supplied payloads
   * for later retrieval.
   *
   * @param interrupts - The interrupt payloads to store.
   */
  markInterrupted(interrupts: InterruptPayload[]): void {
    this.#interrupted = true;
    this.#interrupts.push(...interrupts);
  }

  /**
   * Whether the run ended due to an interrupt.
   *
   * @returns `true` if {@link markInterrupted} was called.
   */
  get interrupted(): boolean {
    return this.#interrupted;
  }

  /**
   * All interrupt payloads collected during the run.
   *
   * @returns A readonly view of the accumulated interrupt payloads.
   */
  get interrupts(): readonly InterruptPayload[] {
    return this.#interrupts;
  }

  /**
   * Returns an async iterator that yields only events whose namespace
   * starts with {@link path}.
   *
   * @param path - Namespace prefix to filter on.
   * @param startAt - Zero-based index into the event log to begin from.
   * @returns An async iterator over matching {@link ProtocolEvent}s.
   */
  subscribeEvents(path: Namespace, startAt = 0): AsyncIterator<ProtocolEvent> {
    const base = this._events.iterate(startAt);
    return {
      async next(): Promise<IteratorResult<ProtocolEvent>> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const result = await base.next();
          if (result.done) return result;
          if (hasPrefix(result.value.params.namespace, path)) {
            return result;
          }
        }
      },
    };
  }
}

/**
 * Background consumer that drains a raw `graph.stream()` source into a
 * {@link StreamMux}.  Converts each chunk to a {@link ProtocolEvent} and
 * pushes it; calls {@link StreamMux.close} on normal completion or
 * {@link StreamMux.fail} on error.
 *
 * @param source - The async iterable of raw stream chunks from the engine.
 * @param mux - The mux instance to feed.
 * @returns A promise that resolves when the source is fully consumed.
 */
export async function pump(
  source: AsyncIterable<StreamChunk>,
  mux: StreamMux
): Promise<void> {
  let seq = 0;
  try {
    for await (const chunk of source) {
      const [ns, mode, payload, meta] = chunk;

      // Detect interrupt payloads attached to values-mode chunks.
      if (mode === "values" && isInterrupted(payload)) {
        const interrupts = (payload as { [INTERRUPT]: Interrupt[] })[INTERRUPT];
        mux.markInterrupted(
          interrupts.map((i) => ({
            interruptId: i.id ?? "",
            payload: i.value,
          }))
        );
      }

      const events = convertToProtocolEvent({
        namespace: ns,
        mode,
        payload,
        seq,
        meta,
      });
      seq += events.length;
      for (const event of events) {
        mux.push(ns, event);
      }
    }
  } catch (err) {
    mux.fail(err);
    return;
  }
  mux.close();
}

/**
 * Serialises a {@link Namespace} array into a single string key using the
 * null byte (`\x00`) as separator, suitable for `Map`/`Set` lookups.
 *
 * @param ns - The namespace segments to join.
 * @returns A null-byte-joined string key.
 */
export function nsKey(ns: Namespace): string {
  return ns.join("\x00");
}

/**
 * Tests whether {@link ns} starts with every segment in {@link prefix}.
 *
 * @param ns - The full namespace to check.
 * @param prefix - The prefix to match against.
 * @returns `true` if `ns` begins with `prefix` segment-by-segment.
 */
export function hasPrefix(ns: Namespace, prefix: Namespace): boolean {
  if (prefix.length > ns.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (ns[i] !== prefix[i]) return false;
  }
  return true;
}
