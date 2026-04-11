/**
 * Built-in graph-level reducers.
 *
 * These reducers are registered automatically for every graph run:
 *
 *   ValuesReducer   — captures values events and resolves run.output.
 *   MessagesReducer — groups messages events into ChatModelStream lifecycles.
 *
 * They run in a fixed order: ValuesReducer first, then MessagesReducer.
 */

import { EventLog } from "./event-log.js";
import { ChatModelStreamImpl } from "./chat-model-stream.js";
import type {
  ChatModelStream,
  MessagesEventData,
  Namespace,
  ProtocolEvent,
  StreamReducer,
} from "./types.js";
import { hasPrefix } from "./mux.js";

/**
 * The projection shape merged into a run stream by the messages reducer.
 * Exposes a `messages` async iterable that yields one {@link ChatModelStream}
 * per AI message lifecycle observed during the run.
 */
export interface MessagesReducerProjection {
  messages: AsyncIterable<ChatModelStream>;
}

/**
 * Creates a {@link StreamReducer} that groups `messages` channel events into
 * per-message {@link ChatModelStream} instances.
 *
 * A new `ChatModelStream` is created on `message-start` and closed on
 * `message-finish`.  Content-block events in between are forwarded to the
 * active stream.  Only events whose namespace exactly matches {@link path}
 * are processed; child namespaces are ignored.
 *
 * @param path - Namespace prefix to match against incoming events.
 * @param nodeFilter - If provided, only events emitted by this graph node
 *   are processed; all others are skipped.
 * @returns A `StreamReducer` whose projection contains the `messages`
 *   async iterable.
 */
export function createMessagesReducer(
  path: Namespace,
  nodeFilter?: string
): StreamReducer<MessagesReducerProjection> {
  const log = new EventLog<ChatModelStream>();
  let active: ChatModelStreamImpl | undefined;

  return {
    init: () => ({
      messages: log.toAsyncIterable(),
    }),

    process(event: ProtocolEvent): boolean {
      if (event.method !== "messages") return true;
      if (!hasPrefix(event.params.namespace, path)) return true;

      // Only capture messages from this graph's own node executions,
      // which sit exactly one namespace level deeper than `path`.
      // Events at `path` itself are chain-level replays from the
      // callback system (handleChainEnd re-emits finalized messages)
      // and would duplicate the streamed content already captured
      // at depth+1.
      const depth = event.params.namespace.length;
      if (depth !== path.length + 1) return true;

      if (nodeFilter !== undefined && event.params.node !== nodeFilter) {
        return true;
      }

      const data = event.params.data as MessagesEventData;

      switch (data.event) {
        case "message-start":
          active = new ChatModelStreamImpl(
            event.params.namespace,
            event.params.node
          );
          log.push(active);
          break;

        case "content-block-start":
        case "content-block-delta":
        case "content-block-finish":
          active?.pushEvent(data);
          break;

        case "message-finish":
          if (active) {
            active.finish(data);
            active = undefined;
          }
          break;

        case "error":
          active?.pushEvent(data);
          break;
      }

      return true;
    },

    finalize(): void {
      if (active) {
        active.finish({
          event: "message-finish",
          reason: "stop",
        });
        active = undefined;
      }
      log.close();
    },

    fail(err: unknown): void {
      active?.fail(err);
      active = undefined;
      log.fail(err);
    },
  };
}

/**
 * The projection shape merged into a run stream by the values reducer.
 * Exposes the underlying {@link EventLog} so that `StreamMux` can resolve
 * the final output value on close.
 */
export interface ValuesReducerProjection {
  _valuesLog: EventLog<Record<string, unknown>>;
}

/**
 * Creates a {@link StreamReducer} that captures `values` channel events
 * into an {@link EventLog}.  Only events whose namespace exactly matches
 * {@link path} are recorded; events from child or sibling namespaces are
 * ignored.
 *
 * The final snapshot is resolved by {@link StreamMux.close} directly;
 * this reducer only accumulates intermediate values.
 *
 * @param path - Namespace prefix to match against incoming events.
 * @returns A `StreamReducer` whose projection contains the internal
 *   `_valuesLog` event log.
 */
export function createValuesReducer(
  path: Namespace
): StreamReducer<ValuesReducerProjection> {
  const valuesLog = new EventLog<Record<string, unknown>>();

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
