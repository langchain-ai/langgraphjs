import type { ChatModelStreamEvent } from "@langchain/core/language_models/event";
import { ChatModelStream as CoreChatModelStream } from "@langchain/core/language_models/stream";
import { hasPrefix } from "../mux.js";
import { StreamChannel } from "../stream-channel.js";
import type {
  ChatModelStream,
  MessagesEventData,
  Namespace,
  ProtocolEvent,
  StreamTransformer,
} from "../types.js";
import type { MessagesTransformerProjection } from "./types.js";

type ActiveMessageStream = {
  source: StreamChannel<ChatModelStreamEvent>;
  stream: ChatModelStream;
};

function getMessageStreamKey(data: MessagesEventData): string {
  const record = data as unknown as Record<string, unknown>;
  if (typeof record.run_id === "string") return `run:${record.run_id}`;
  if (data.event === "message-start" && typeof record.id === "string") {
    return `message:${record.id}`;
  }
  return "__default__";
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
  const log = StreamChannel.local<ChatModelStream>();
  const active = new Map<string, ActiveMessageStream>();

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
          const key = getMessageStreamKey(data);
          const source = StreamChannel.local<ChatModelStreamEvent>();
          const stream = Object.assign(
            new CoreChatModelStream(source.toAsyncIterable()),
            {
              namespace: event.params.namespace,
              node: event.params.node,
            }
          ) as ChatModelStream;
          active.set(key, { source, stream });
          source.push(data as unknown as ChatModelStreamEvent);
          log.push(stream);
          break;
        }

        case "content-block-start":
        case "content-block-delta":
        case "content-block-finish":
          active
            .get(getMessageStreamKey(data))
            ?.source.push(data as unknown as ChatModelStreamEvent);
          break;

        case "message-finish": {
          const key = getMessageStreamKey(data);
          const stream = active.get(key);
          if (stream) {
            stream.source.push(data as unknown as ChatModelStreamEvent);
            stream.source.close();
            active.delete(key);
          }
          break;
        }

        case "error":
          active
            .get(getMessageStreamKey(data))
            ?.source.push(data as unknown as ChatModelStreamEvent);
          break;
      }

      return true;
    },

    finalize(): void {
      for (const [key, stream] of active) {
        stream.source.push({ event: "message-finish" });
        stream.source.close();
        active.delete(key);
      }
      log.close();
    },

    fail(err: unknown): void {
      for (const [key, stream] of active) {
        stream.source.fail(err);
        active.delete(key);
      }
      log.fail(err);
    },
  };
}
