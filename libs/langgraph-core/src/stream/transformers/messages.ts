import { ChatModelStreamImpl } from "../chat-model-stream.js";
import { EventLog } from "../event-log.js";
import { hasPrefix } from "../mux.js";
import type {
  ChatModelStream,
  MessagesEventData,
  Namespace,
  ProtocolEvent,
  StreamTransformer,
} from "../types.js";
import type { MessagesTransformerProjection } from "./types.js";

/**
 * Creates a {@link StreamTransformer} that groups `messages` channel events into
 * per-message {@link ChatModelStream} instances.
 *
 * A new `ChatModelStream` is created on `message-start` and closed on
 * `message-finish`. Content-block events in between are forwarded to the
 * active stream. Only events whose namespace exactly matches {@link path}
 * are processed; child namespaces are ignored.
 *
 * @param path - Namespace prefix to match against incoming events.
 * @param nodeFilter - If provided, only events emitted by this graph node
 *   are processed; all others are skipped.
 * @returns A `StreamTransformer` whose projection contains the `messages`
 *   async iterable.
 */
export function createMessagesTransformer(
  path: Namespace,
  nodeFilter?: string
): StreamTransformer<MessagesTransformerProjection> {
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
