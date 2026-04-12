/**
 * StreamMux — central dispatcher with reducer pipeline.
 *
 * Routes raw stream chunks through registered StreamReducers, then appends
 * the resulting ProtocolEvents to the main EventLog.  Also tracks namespace
 * discovery for SubgraphRunStream creation.
 *
 * lifecycle:
 *   graph.streamV2(input)
 *     ├─ StreamMux starts pumping from graph.stream(…, { subgraphs: true })
 *     ├─ For each ProtocolEvent:
 *     │   ├─ reducer_1.process(event)
 *     │   ├─ reducer_2.process(event)
 *     │   └─ event appended to _events (unless suppressed)
 *     └─ On close: reducer_n.finalize() called in registration order
 */

import type { StreamChunk } from "../pregel/stream.js";
import { INTERRUPT, isInterrupted, type Interrupt } from "../constants.js";
import { EventLog } from "./event-log.js";
import { convertToProtocolEvent, STREAM_V2_MODES } from "./convert.js";
import type {
  InterruptPayload,
  Namespace,
  ProtocolEvent,
  StreamReducer,
} from "./types.js";

export { STREAM_V2_MODES };

/**
 * A discovered subgraph namespace paired with its run stream handle.
 */
export type SubgraphDiscovery = {
  ns: Namespace;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stream: any;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _SubgraphRunStreamCtor: new (...args: any[]) => any;

/**
 * Registers the concrete run-stream constructors used by {@link StreamMux}
 * to create subgraph stream handles.  Called once by `run-stream.ts` at
 * module load to break the circular dependency.
 *
 * @internal
 * @param _graphCtor - The graph-level run stream constructor (unused here,
 *   accepted for symmetry with the registration call).
 * @param subCtor - The subgraph run stream constructor instantiated for
 *   each newly discovered namespace.
 */
export function setRunStreamClasses(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _graphCtor: new (...args: any[]) => any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  subCtor: new (...args: any[]) => any
): void {
  _SubgraphRunStreamCtor = subCtor;
}

/**
 * Central event dispatcher that routes {@link ProtocolEvent}s through a
 * pipeline of {@link StreamReducer}s, manages namespace discovery for
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

  /** Monotonic counter for events emitted by reducers via `emit()`. */
  #nextEmitSeq = 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #reducers: StreamReducer<any>[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly #streamMap = new Map<string, any>();
  readonly #seenNs = new Set<string>();
  readonly #latestValues = new Map<string, Record<string, unknown>>();
  readonly #interrupts: InterruptPayload[] = [];
  #interrupted = false;

  /**
   * Associates a pre-existing stream handle with a namespace so that
   * {@link close} can resolve its values promise later.
   *
   * @param path - The namespace path to register.
   * @param stream - The run stream handle for that namespace.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  register(path: Namespace, stream: any): void {
    this.#streamMap.set(nsKey(path), stream);
  }

  /**
   * Appends a reducer to the pipeline.  Reducers run in registration order
   * for every event passed to {@link push}.
   *
   * @param reducer - The reducer to add.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addReducer(reducer: StreamReducer<any>): void {
    this.#reducers.push(reducer);
  }

  /**
   * Distributes an event through the reducer pipeline, then appends it to
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
    if (ns.length > 0) {
      const topNs = ns.slice(0, 1);
      const topKey = nsKey(topNs);
      if (!this.#seenNs.has(topKey)) {
        this.#seenNs.add(topKey);
        const subStream = new _SubgraphRunStreamCtor(
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

    // Track seq from the incoming event so reducer-emitted events
    // get subsequent sequence numbers.
    this.#nextEmitSeq = Math.max(this.#nextEmitSeq, event.seq + 1);

    const pendingEmissions: ProtocolEvent[] = [];
    const emit = (method: string, data: unknown) => {
      pendingEmissions.push({
        type: "event",
        seq: this.#nextEmitSeq++,
        method: method as ProtocolEvent["method"],
        params: { namespace: ns, timestamp: Date.now(), data },
      });
    };

    let keep = true;
    for (const reducer of this.#reducers) {
      if (!reducer.process(event, emit)) {
        keep = false;
      }
    }

    if (keep) {
      this._events.push(event);
    }

    for (const emitted of pendingEmissions) {
      this._events.push(emitted);
    }
  }

  /**
   * Gracefully ends the stream: resolves values promises on all known
   * streams, finalizes every reducer, and closes both event logs.
   */
  close(): void {
    for (const [key, values] of this.#latestValues.entries()) {
      const ns = key ? key.split("\x00") : [];
      const stream = this.#streamMap.get(nsKey(ns));
      stream?._resolveValues(values);
    }

    const finalizeEmit = (method: string, data: unknown) => {
      this._events.push({
        type: "event",
        seq: this.#nextEmitSeq++,
        method: method as ProtocolEvent["method"],
        params: { namespace: [], timestamp: Date.now(), data },
      });
    };

    for (const reducer of this.#reducers) {
      reducer.finalize(finalizeEmit);
    }

    this._events.close();
    this._discoveries.close();

    for (const stream of this.#streamMap.values()) {
      stream._resolveValues(undefined);
    }
  }

  /**
   * Propagates a failure to all reducers, event logs, and stream handles.
   *
   * @param err - The error that caused the run to fail.
   */
  fail(err: unknown): void {
    const failEmit = (method: string, data: unknown) => {
      this._events.push({
        type: "event",
        seq: this.#nextEmitSeq++,
        method: method as ProtocolEvent["method"],
        params: { namespace: [], timestamp: Date.now(), data },
      });
    };

    for (const reducer of this.#reducers) {
      reducer.fail(err, failEmit);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): AsyncIterator<any> {
    const base = this._discoveries.iterate(startAt);
    const targetDepth = path.length + 1;
    return {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async next(): Promise<IteratorResult<any>> {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const result = await base.next();
          if (result.done) {
            return { value: undefined, done: true };
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
