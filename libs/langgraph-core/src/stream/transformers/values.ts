import { hasPrefix } from "../mux.js";
import { StreamChannel } from "../stream-channel.js";
import type { Namespace, ProtocolEvent, StreamTransformer } from "../types.js";
import type { ValuesTransformerProjection } from "./types.js";

/**
 * Creates a {@link StreamTransformer} that captures `values` channel events
 * into a local {@link StreamChannel}. Only events whose namespace exactly
 * matches {@link path} are recorded; events from child or sibling namespaces
 * are ignored.
 *
 * The final snapshot is resolved by {@link StreamMux.close} directly;
 * this transformer only accumulates intermediate values.
 *
 * @param path - Namespace prefix to match against incoming events.
 * @returns A `StreamTransformer` whose projection contains the internal
 *   `_valuesLog` local channel.
 */
export function createValuesTransformer(
  path: Namespace
): StreamTransformer<ValuesTransformerProjection> {
  const valuesLog = StreamChannel.local<Record<string, unknown>>();

  return {
    init: () => ({ _valuesLog: valuesLog }),

    process(event: ProtocolEvent): boolean {
      if (event.method !== "values") return true;
      if (event.params.namespace.length !== path.length) return true;
      if (!hasPrefix(event.params.namespace, path)) return true;
      valuesLog.push(event.params.data as Record<string, unknown>);
      return true;
    },

    finalize(): void {
      valuesLog.close();
    },

    fail(err: unknown): void {
      valuesLog.fail(err);
    },
  };
}
