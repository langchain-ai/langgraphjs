/**
 * StreamMux — central dispatcher with transformer pipeline.
 *
 * Routes raw stream chunks through registered StreamTransformers, then appends
 * the resulting ProtocolEvents to the main EventLog.  Also tracks namespace
 * discovery for SubgraphRunStream creation.
 *
 * lifecycle:
 *   graph.streamV2(input)
 *     ├─ StreamMux starts pumping from graph.stream(…, { subgraphs: true })
 *     ├─ For each ProtocolEvent:
 *     │   ├─ transformer_1.process(event)
 *     │   ├─ transformer_2.process(event)
 *     │   └─ event appended to _events (unless suppressed)
 *     └─ On close: transformer_n.finalize() called in registration order
 */

import type { StreamChunk } from "../pregel/stream.js";
import { INTERRUPT, isInterrupted, type Interrupt } from "../constants.js";
import { EventLog } from "./event-log.js";
import { convertToProtocolEvent, STREAM_V2_MODES } from "./convert.js";
import { isStreamChannel, type StreamChannel } from "./stream-channel.js";
import type {
  InterruptPayload,
  Namespace,
  ProtocolEvent,
  StreamTransformer,
} from "./types.js";

export { STREAM_V2_MODES };

/**
 * Minimal interface that {@link StreamMux} requires from stream handles
 * for lifecycle resolution. This avoids a direct dependency on
 * `GraphRunStream` / `SubgraphRunStream`.
 */
export interface StreamHandle {
  _resolveValues(values: unknown): void;
  _rejectValues(err: unknown): void;
}

/**
 * Factory function that creates a subgraph stream handle for a newly
 * discovered namespace. Injected into {@link StreamMux} at construction
 * time, keeping mux decoupled from the concrete stream classes.
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
 * One `StreamMux` instance exists per top-level `streamV2()` invocation.
 */
export class StreamMux {
  /** @internal All protocol events in arrival order (after reducer pipeline). */
  readonly _events = new EventLog<ProtocolEvent>();

  /** @internal New-namespace discovery notifications. */
  readonly _discoveries = new EventLog<SubgraphDiscovery>();

  /** Monotonic counter for auto-forwarded channel events. */
  #nextEmitSeq = 0;

  /** Whether the run was interrupted. */
  #interrupted = false;

  /**
   * Namespace of the event currently being processed by
   * {@link push}.  Read by {@link StreamChannel} wiring callbacks so
   * auto-forwarded events inherit the triggering event's namespace.
   */
  #currentNamespace: Namespace = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #transformers: StreamTransformer<any>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #channels: StreamChannel<any>[] = [];
  readonly #streamMap = new Map<string, StreamHandle>();
  readonly #seenNs = new Set<string>();
  readonly #latestValues = new Map<string, Record<string, unknown>>();
  readonly #interrupts: InterruptPayload[] = [];
  readonly #createSubgraphStream: SubgraphStreamFactory | undefined;

  /**
   * @param createSubgraphStream - Optional factory for creating subgraph
   *   stream handles when new namespaces are discovered. When omitted,
   *   subgraph discovery is disabled (useful for unit-testing the mux
   *   in isolation).
   */
  constructor(createSubgraphStream?: SubgraphStreamFactory) {
    this.#createSubgraphStream = createSubgraphStream;
  }

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
   * Appends a transformer to the pipeline.  Transformers run in registration
   * order for every event passed to {@link push}.
   *
   * @param transformer - The transformer to add.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addTransformer(transformer: StreamTransformer<any>): void {
    this.#transformers.push(transformer);
  }

  /**
   * Scans a transformer projection for {@link StreamChannel} instances and
   * wires each one to auto-forward pushes as protocol events.
   *
   * @param projection - The object returned by `transformer.init()`.
   */
  wireChannels(projection: Record<string, unknown>): void {
    for (const value of Object.values(projection)) {
      if (!isStreamChannel(value)) continue;
      this.#channels.push(value);
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
    }
  }

  /**
   * Distributes an event through the transformer pipeline, then appends it to
   * the main event log.  Creates {@link SubgraphDiscovery} entries for any
   * namespace segments not yet seen.
   *
   * @param ns - The namespace path that produced the event.
   * @param event - The protocol event to process and store.
   */
  push(ns: Namespace, event: ProtocolEvent): void {
    // Only announce first-level namespace segments as discoverable
    // subgraphs.  Deeper segments (e.g. ["researcher:uuid", "tools:uuid"])
    // are internal Pregel checkpoint namespace entries for nodes within a
    // subgraph and should not appear as user-facing SubgraphRunStream
    // instances.  We still track them in #seenNs / #streamMap so that
    // values resolution and event filtering work correctly.
    if (ns.length > 0 && this.#createSubgraphStream) {
      const topNs = ns.slice(0, 1);
      const topKey = nsKey(topNs);
      if (!this.#seenNs.has(topKey)) {
        this.#seenNs.add(topKey);
        const subStream = this.#createSubgraphStream(
          topNs,
          this,
          this._discoveries.size,
          this._events.size
        );
        this.#streamMap.set(topKey, subStream);
        this._discoveries.push({ ns: topNs, stream: subStream });
      }
    }

    if (event.method === "values") {
      this.#latestValues.set(
        nsKey(ns),
        event.params.data as Record<string, unknown>
      );
    }

    // Track seq from the incoming event so channel-forwarded events
    // get subsequent sequence numbers.
    this.#nextEmitSeq = Math.max(this.#nextEmitSeq, event.seq + 1);

    // Set current namespace so StreamChannel auto-forward callbacks
    // can attach it to emitted protocol events.
    this.#currentNamespace = ns;

    let keep = true;
    for (const transformer of this.#transformers) {
      if (!transformer.process(event)) {
        keep = false;
      }
    }

    this.#currentNamespace = [];

    if (keep) {
      this._events.push(event);
    }
  }

  /**
   * Gracefully ends the stream: resolves values promises on all known
   * streams, finalizes every transformer, auto-closes channels, and
   * closes both event logs.
   */
  close(): void {
    for (const [key, values] of this.#latestValues.entries()) {
      const ns = key ? key.split("\x00") : [];
      const stream = this.#streamMap.get(nsKey(ns));
      stream?._resolveValues(values);
    }

    for (const transformer of this.#transformers) {
      transformer.finalize?.();
    }

    for (const channel of this.#channels) {
      channel._close();
    }

    this._events.close();
    this._discoveries.close();

    for (const stream of this.#streamMap.values()) {
      stream._resolveValues(undefined);
    }
  }

  /**
   * Propagates a failure to all transformers, channels, event logs, and
   * stream handles.
   *
   * @param err - The error that caused the run to fail.
   */
  fail(err: unknown): void {
    for (const transformer of this.#transformers) {
      transformer.fail?.(err);
    }
    for (const channel of this.#channels) {
      channel._fail(err);
    }
    this._events.fail(err);
    this._discoveries.fail(err);
    for (const stream of this.#streamMap.values()) {
      stream._rejectValues(err);
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

  /**
   * Returns an async iterator that yields subgraph stream handles for
   * direct children of {@link path} (i.e. namespaces exactly one level
   * deeper).
   *
   * @param path - Parent namespace to watch for children.
   * @param startAt - Zero-based index into the discovery log to begin from.
   * @returns An async iterator over subgraph stream handles.
   */
  subscribeSubgraphs(
    path: Namespace,
    startAt = 0
  ): AsyncIterator<StreamHandle> {
    const base = this._discoveries.iterate(startAt);
    const targetDepth = path.length + 1;
    return {
      async next(): Promise<IteratorResult<StreamHandle>> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const result = await base.next();
          if (result.done) {
            return { value: undefined as unknown as StreamHandle, done: true };
          }
          const { ns, stream } = result.value;
          if (ns.length === targetDepth && hasPrefix(ns, path)) {
            return { value: stream, done: false };
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
      const [ns, mode, payload] = chunk;

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

      const event = convertToProtocolEvent(ns, mode, payload, seq);
      seq += 1;
      if (event !== null) {
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
