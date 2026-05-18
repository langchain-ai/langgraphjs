/**
 * SubgraphDiscoveryTransformer - materializes a {@link StreamHandle} for
 * each newly observed top-level subgraph namespace and announces it on
 * the mux's shared {@link StreamMux._discoveries} channel.
 *
 * Previously this work was inlined in {@link StreamMux.push}.  Extracting
 * it into a transformer aligns discovery with the rest of the stream
 * architecture (lifecycle, values, messages are all transformers),
 * isolates the factory wiring, and makes discovery behavior
 * independently testable.
 *
 * The transformer also owns the read-side of discovery: it exposes an
 * `AsyncIterable<TStream>` projection (`subgraphs`) scoped to the root
 * namespace, and a {@link filterSubgraphHandles} helper that callers
 * can use to scope the same channel to any descendant namespace.  This
 * lets `GraphRunStream` drop its bespoke `subscribeSubgraphs`
 * delegation and surface child streams via the standard native
 * projection pattern.
 *
 * Only first-level namespace segments are announced.  Deeper segments
 * (e.g. `["researcher:uuid", "tools:uuid"]`) are internal Pregel
 * checkpoint namespaces for nodes inside a subgraph and should not
 * appear as user-facing `SubgraphRunStream` instances; the mux still
 * resolves their values via its own `#streamMap` when registered
 * elsewhere.
 */

import { hasPrefix, nsKey } from "../mux.js";
import type { StreamHandle, StreamMux, SubgraphDiscovery } from "../mux.js";
import type {
  Namespace,
  NativeStreamTransformer,
  ProtocolEvent,
} from "../types.js";
import type { StreamChannel } from "../stream-channel.js";

/**
 * Projection returned by {@link createSubgraphDiscoveryTransformer}.
 *
 * @typeParam TStream - Concrete stream handle type produced by the
 *   configured factory (e.g. `SubgraphRunStream`).
 */
export interface SubgraphDiscoveryProjection<
  TStream extends StreamHandle = StreamHandle,
> {
  /**
   * Shared discovery channel on the mux.  The transformer writes to it so
   * the channel's lifetime stays tied to the mux (closed on `mux.close()`
   * / failed on `mux.fail()`).  The underscore prefix signals internal
   * wiring: consumers should iterate {@link subgraphs} instead.
   */
  _discoveries: StreamChannel<SubgraphDiscovery>;

  /**
   * Async iterable of direct child stream handles of the root
   * namespace.  Wired onto `GraphRunStream.subgraphs` during root
   * stream construction.  For descendant namespaces, use
   * {@link filterSubgraphHandles} to scope the same log.
   */
  subgraphs: AsyncIterable<TStream>;
}

/**
 * Configuration for {@link createSubgraphDiscoveryTransformer}.
 */
export interface SubgraphDiscoveryTransformerOptions<
  TStream extends StreamHandle = StreamHandle,
> {
  /**
   * Factory invoked once per newly observed top-level namespace.
   *
   * Receives the discovery-channel and event-channel offsets so the resulting
   * stream can iterate only events arriving after the namespace was
   * first seen (no retroactive replay).
   *
   * @param path - The single-segment top-level namespace.
   * @param discoveryStart - Current size of the mux discovery log.
   * @param eventStart - Current size of the mux event log.
   * @returns A stream handle registered with the mux for values/error
   *   resolution on close/fail.
   */
  createStream: (
    path: Namespace,
    discoveryStart: number,
    eventStart: number
  ) => TStream;
}

/**
 * Filter a {@link SubgraphDiscovery} channel to only the direct children
 * of a given namespace.
 *
 * Returns an `AsyncIterable` whose iterator yields stream handles for
 * discoveries whose namespace is exactly one segment deeper than
 * {@link path} and shares it as a prefix.  Iteration begins at
 * {@link startAt} (so each caller picks up only discoveries added
 * after its construction) and terminates when the underlying log
 * closes or fails.
 *
 * @typeParam TStream - Concrete stream type recorded in the log.
 *   Callers may cast if the log was populated by a specific factory.
 * @param log - The shared discovery channel (`mux._discoveries`).
 * @param path - Parent namespace whose direct children should be
 *   yielded.
 * @param startAt - Zero-based index into the discovery log to begin
 *   from.
 * @returns An async iterable of stream handles.
 */
export function filterSubgraphHandles<
  TStream extends StreamHandle = StreamHandle,
>(
  log: StreamChannel<SubgraphDiscovery>,
  path: Namespace,
  startAt = 0
): AsyncIterable<TStream> {
  const targetDepth = path.length + 1;
  return {
    [Symbol.asyncIterator](): AsyncIterator<TStream> {
      const base = log.iterate(startAt);
      return {
        async next(): Promise<IteratorResult<TStream>> {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const result = await base.next();
            if (result.done) {
              return { value: undefined as unknown as TStream, done: true };
            }
            const { ns, stream } = result.value;
            if (ns.length === targetDepth && hasPrefix(ns, path)) {
              return { value: stream as TStream, done: false };
            }
          }
        },
      };
    },
  };
}

/**
 * Create the subgraph discovery transformer.
 *
 * Registering this transformer against a mux replaces the legacy
 * inline behavior that previously lived in {@link StreamMux.push}.
 * The mux no longer knows about the subgraph factory: instead, this
 * transformer is the single component that materializes stream
 * handles and announces them on `_discoveries`.
 *
 * Marked as a {@link NativeStreamTransformer} so the projection is
 * treated as internal wiring (not merged into `run.extensions` and
 * not auto-forwarded via {@link StreamMux.wireChannels}).
 *
 * @typeParam TStream - Concrete stream handle type produced by
 *   {@link SubgraphDiscoveryTransformerOptions.createStream}.
 *   Defaults to the base {@link StreamHandle} interface.
 * @param mux - The mux whose `_discoveries` log should receive
 *   discovery entries and whose `register` will be called for each
 *   new stream handle.
 * @param options - Factory and related wiring.
 * @returns A native transformer that populates
 *   {@link StreamMux._discoveries} and exposes a root-scoped
 *   `subgraphs` iterable via its projection.
 */
export function createSubgraphDiscoveryTransformer<
  TStream extends StreamHandle = StreamHandle,
>(
  mux: StreamMux,
  options: SubgraphDiscoveryTransformerOptions<TStream>
): NativeStreamTransformer<SubgraphDiscoveryProjection<TStream>> {
  const { createStream } = options;
  const seen = new Set<string>();

  return {
    __native: true,

    init() {
      return {
        _discoveries: mux._discoveries,
        subgraphs: filterSubgraphHandles<TStream>(mux._discoveries, [], 0),
      };
    },

    process(event: ProtocolEvent): boolean {
      const ns = event.params.namespace;
      if (ns.length === 0) return true;

      const topNs = ns.slice(0, 1);
      const topKey = nsKey(topNs);
      if (seen.has(topKey)) return true;
      seen.add(topKey);

      const stream = createStream(
        topNs,
        mux._discoveries.size,
        mux._events.size
      );
      mux.register(topNs, stream);
      mux._discoveries.push({ ns: topNs, stream });
      return true;
    },
  };
}
