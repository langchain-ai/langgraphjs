import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { ChatModelStream as CoreChatModelStream } from "@langchain/core/language_models/stream";
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

type ActiveMessageStream = {
  source: EventLog<ChatModelStreamEvent>;
  stream: ChatModelStream;
};

// Keep this adapter until the protocol package and Core share a single
// ChatModelStreamEvent type. The runtime shape is intentionally aligned; the
// generated protocol types still differ from Core's content block definitions
// and narrower finish-reason union. Core now accepts protocol-compatible
// partial usage directly, so no value normalization is needed here.
function toCoreEvent(data: MessagesEventData): ChatModelStreamEvent {
  return data as unknown as ChatModelStreamEvent;
}

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
  let active: ActiveMessageStream | undefined;

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
        case "message-start": {
          const source = new EventLog<ChatModelStreamEvent>();
          const stream = Object.assign(
            new CoreChatModelStream(source.toAsyncIterable()),
            {
              namespace: event.params.namespace,
              node: event.params.node,
            }
          ) as ChatModelStream;
          active = { source, stream };
          source.push(toCoreEvent(data));
          log.push(stream);
          break;
        }

        case "content-block-start":
        case "content-block-delta":
        case "content-block-finish":
          active?.source.push(toCoreEvent(data));
          break;

        case "message-finish":
          if (active) {
            active.source.push(toCoreEvent(data));
            active.source.close();
            active = undefined;
          }
          break;

        case "error":
          active?.source.push(toCoreEvent(data));
          break;
      }

      return true;
    },

    finalize(): void {
      if (active) {
        active.source.push({ event: "message-finish" });
        active.source.close();
        active = undefined;
      }
      log.close();
    },

    fail(err: unknown): void {
      active?.source.fail(err);
      active = undefined;
      log.fail(err);
    },
  };
}
